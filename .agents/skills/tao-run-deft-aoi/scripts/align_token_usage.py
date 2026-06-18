# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Align Claude Code transcript token usage to loop_log stages (post-processing).

Why this exists: `log_stage.py` is a passive writer. The bash orchestrator that
calls it has no way to measure LLM context size, so `context_tokens` ends up as
a hard-coded placeholder. The real per-call usage *is* recorded by Claude Code
in its transcript JSONLs (`~/.claude/projects/<slug>/<session-id>.jsonl`); each
assistant message has a `timestamp` and `message.usage` with `input_tokens`,
`output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`
(plus the 5m/1h breakdown).

This script runs after a loop (or any time you want updated numbers). For each
stage entry in `loop_log.jsonl`, it sums the usage of every assistant message
whose timestamp falls in `(prev_entry.ts, this_entry.ts]` (the first entry
covers `[transcript_start, entry_1.ts]`), then writes a per-stage `tokens`
field and updates `context_tokens` to the real context size at stage end.

The original `loop_log.jsonl` is rewritten atomically (tmp + rename). Existing
fields are preserved; `seq` is untouched.

CLI:

    python scripts/align_token_usage.py \
        --log-path /abs/path/results/loop_log.jsonl \
        --project-dir ~/.claude/projects/-home-user-tao-skills-external

    # or pass individual transcript files (repeatable):
    python scripts/align_token_usage.py \
        --log-path /abs/path/results/loop_log.jsonl \
        --transcript /path/to/session-a.jsonl \
        --transcript /path/to/session-b.jsonl

    # or auto-resolve the project dir from cwd (default: current cwd):
    python scripts/align_token_usage.py \
        --log-path /abs/path/results/loop_log.jsonl \
        --cwd ~/tao-skills-external

The per-entry `tokens` field shape:

    {
      "n_messages": int,            # assistant messages attributed to this stage
      "input": int,                 # uncached input tokens
      "output": int,
      "cache_read": int,
      "cache_create": int,          # total (5m + 1h)
      "cache_create_5m": int,
      "cache_create_1h": int,
      "context_size_end": int,      # last message's input+cache_read+cache_create
      "models": [str]               # distinct model IDs seen in this stage
    }
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import sys
import tempfile


def _parse_ts(s: str) -> datetime.datetime:
    """Parse an ISO-8601 timestamp (with trailing 'Z' or offset) to aware UTC."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def cwd_to_project_slug(cwd: pathlib.Path) -> str:
    """Translate an absolute cwd to its Claude Code project slug.

    Claude Code stores transcripts under `~/.claude/projects/<slug>/` where the
    slug is the absolute path with every `/` replaced by `-` (leading `/`
    becomes a leading `-`).
    """
    abs_cwd = str(cwd.resolve())
    return abs_cwd.replace("/", "-")


def discover_project_dir(cwd: pathlib.Path) -> pathlib.Path:
    """Resolve `~/.claude/projects/<slug>` from a project cwd."""
    return pathlib.Path.home() / ".claude" / "projects" / cwd_to_project_slug(cwd)


def collect_assistant_usage(
    transcript_paths: list[pathlib.Path],
) -> list[dict]:
    """Read transcripts and return a list of {ts, usage, model} dicts sorted by ts."""
    out: list[dict] = []
    for p in transcript_paths:
        if not p.is_file():
            print(f"align_token_usage: skipping non-file {p}", file=sys.stderr)
            continue
        with p.open() as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") != "assistant":
                    continue
                msg = rec.get("message") or {}
                usage = msg.get("usage")
                ts_raw = rec.get("timestamp")
                if not usage or not ts_raw:
                    continue
                try:
                    ts = _parse_ts(ts_raw)
                except ValueError:
                    continue
                out.append(
                    {
                        "ts": ts,
                        "usage": usage,
                        "model": msg.get("model"),
                    }
                )
    out.sort(key=lambda r: r["ts"])
    return out


def _empty_tokens() -> dict:
    return {
        "n_messages": 0,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_create": 0,
        "cache_create_5m": 0,
        "cache_create_1h": 0,
        "context_size_end": 0,
        "models": [],
    }


def _accumulate(acc: dict, msg: dict) -> None:
    u = msg["usage"]
    inp = int(u.get("input_tokens", 0) or 0)
    out = int(u.get("output_tokens", 0) or 0)
    cr = int(u.get("cache_read_input_tokens", 0) or 0)
    cc_total = int(u.get("cache_creation_input_tokens", 0) or 0)
    cc_detail = u.get("cache_creation") or {}
    cc_5m = int(cc_detail.get("ephemeral_5m_input_tokens", 0) or 0)
    cc_1h = int(cc_detail.get("ephemeral_1h_input_tokens", 0) or 0)
    # If the breakdown is missing/zero but the total is present, attribute to 5m
    # (the common case for Claude Code's default cache writes).
    if cc_total and not (cc_5m or cc_1h):
        cc_5m = cc_total

    acc["n_messages"] += 1
    acc["input"] += inp
    acc["output"] += out
    acc["cache_read"] += cr
    acc["cache_create"] += cc_total
    acc["cache_create_5m"] += cc_5m
    acc["cache_create_1h"] += cc_1h
    # context_size_end = the LAST message's pre-output context (input + cache_*)
    acc["context_size_end"] = inp + cr + cc_total
    model = msg.get("model")
    if model and model not in acc["models"]:
        acc["models"].append(model)


def align(
    log_path: pathlib.Path,
    transcript_paths: list[pathlib.Path],
) -> tuple[list[dict], list[dict]]:
    """Return (new_entries, messages). Does not write to disk."""
    if not log_path.is_file():
        raise FileNotFoundError(f"log not found: {log_path}")

    entries: list[dict] = []
    with log_path.open() as f:
        for line in f:
            if not line.strip():
                continue
            entries.append(json.loads(line))
    if not entries:
        return [], []

    parsed_ts: list[datetime.datetime] = []
    for i, e in enumerate(entries):
        ts_raw = e.get("ts")
        if not ts_raw:
            raise ValueError(f"entry seq={e.get('seq')!r} (index {i}) has no 'ts'")
        parsed_ts.append(_parse_ts(ts_raw))

    messages = collect_assistant_usage(transcript_paths)

    # Walk messages and entries together; both are time-sorted, so this is O(N+M).
    new_entries: list[dict] = []
    mi = 0
    for ei, entry in enumerate(entries):
        end = parsed_ts[ei]
        prev = parsed_ts[ei - 1] if ei > 0 else None  # first entry: no lower bound
        acc = _empty_tokens()
        while mi < len(messages) and messages[mi]["ts"] <= end:
            mts = messages[mi]["ts"]
            if prev is None or mts > prev:
                _accumulate(acc, messages[mi])
            mi += 1
        merged = dict(entry)
        merged["tokens"] = acc
        merged["context_tokens"] = acc["context_size_end"]
        new_entries.append(merged)

    return new_entries, messages


def write_atomic(log_path: pathlib.Path, entries: list[dict]) -> None:
    """Rewrite log_path atomically (write to a sibling tmp, then rename)."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=log_path.name + ".", suffix=".tmp", dir=str(log_path.parent)
    )
    try:
        with os.fdopen(fd, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        os.replace(tmp_name, log_path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Align Claude Code transcript token usage to loop_log.jsonl stages. "
            "Rewrites the log in place, adding per-stage `tokens` fields and "
            "updating `context_tokens` to the real value."
        ),
    )
    parser.add_argument(
        "--log-path",
        required=True,
        type=pathlib.Path,
        help="Absolute path to results/loop_log.jsonl",
    )
    parser.add_argument(
        "--transcript",
        action="append",
        default=[],
        type=pathlib.Path,
        help=(
            "Path to a Claude Code transcript JSONL. Repeatable. If omitted, "
            "transcripts are discovered under --project-dir."
        ),
    )
    parser.add_argument(
        "--project-dir",
        type=pathlib.Path,
        default=None,
        help=(
            "Directory containing transcript JSONLs (every *.jsonl is scanned). "
            "If omitted and --transcript is also omitted, resolved from --cwd."
        ),
    )
    parser.add_argument(
        "--cwd",
        type=pathlib.Path,
        default=None,
        help=(
            "Project root used to compute the Claude Code project slug "
            "(<home>/.claude/projects/<slug>). Defaults to the current cwd."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the new entries to stdout; do not modify the log file.",
    )
    return parser


def _resolve_transcripts(args: argparse.Namespace) -> list[pathlib.Path]:
    if args.transcript:
        return list(args.transcript)
    project_dir = args.project_dir
    if project_dir is None:
        cwd = args.cwd or pathlib.Path.cwd()
        project_dir = discover_project_dir(cwd)
    if not project_dir.is_dir():
        raise FileNotFoundError(f"project dir not found: {project_dir}")
    return sorted(project_dir.glob("*.jsonl"))


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        transcripts = _resolve_transcripts(args)
        if not transcripts:
            print("align_token_usage: no transcripts found", file=sys.stderr)
            return 2
        new_entries, messages = align(args.log_path, transcripts)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"align_token_usage: {exc}", file=sys.stderr)
        return 2

    if not new_entries:
        print("align_token_usage: log is empty, nothing to do", file=sys.stderr)
        return 0

    if args.dry_run:
        for e in new_entries:
            print(json.dumps(e))
    else:
        write_atomic(args.log_path, new_entries)

    total_msgs = sum(e["tokens"]["n_messages"] for e in new_entries)
    print(
        f"align_token_usage: {len(new_entries)} stages, "
        f"{total_msgs}/{len(messages)} assistant messages attributed",
        file=sys.stderr,
    )
    # If transcripts existed but no assistant messages landed inside any
    # stage's time window, the report will silently show context_tokens=0
    # for every entry. That hides a real problem (wrong project dir, clock
    # skew, transcripts from a different session). Surface it as a non-zero
    # exit so the loop-end sequence catches it.
    if total_msgs == 0:
        print(
            "align_token_usage: 0 messages attributed across "
            f"{len(messages)} candidate(s); check --project-dir / --cwd / clock skew",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
