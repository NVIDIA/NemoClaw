# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Append a stage entry to results/loop_log.jsonl.

Disk-truth invariant: never trust in-memory seq across turns. Always re-read
the last entry of the log to compute next_seq. Context compaction is invisible
to this writer — there is no "compacted" flag and no detection branch.

`context_tokens` is a placeholder field. This writer cannot measure LLM context
size — bash and `run_script()` callers don't have access to it. Pass 0 (or omit
the CLI flag) and run `scripts/align_token_usage.py` after the loop to backfill
real per-stage usage from the Claude Code transcript.

Library usage:

    from log_stage import append_stage
    import time, pathlib

    t0 = time.monotonic()
    # ... run the stage ...
    append_stage(
        pathlib.Path(f"{RESULTS_DIR}/loop_log.jsonl"),
        iter_label="iter1",
        stage="anomalygen",
        status="ok",
        summary="generated 1024 triplets, 8 defect types",
        duration_sec=int(time.monotonic() - t0),
    )

CLI usage (for `run_script()` callers):

    python scripts/log_stage.py \
        --log-path /abs/path/results/loop_log.jsonl \
        --iter-label iter1 \
        --stage anomalygen \
        --status ok \
        --summary "generated 1024 triplets, 8 defect types" \
        --duration-sec 612
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import sys

_VALID_STATUSES = {"ok", "error"}
_VALID_STAGES = {
    "evaluate",
    "rca",
    "anomalygen",
    "routing",
    "data_mining",
    "train",
    "loop_stop",
}


def next_seq(log_path: pathlib.Path) -> int:
    """Return seq for the next entry: last entry's seq + 1, or 1 if no log yet."""
    if not isinstance(log_path, pathlib.Path):
        raise TypeError(
            f"log_path must be pathlib.Path, got {type(log_path).__name__}"
        )
    if not log_path.exists():
        return 1
    last = None
    with log_path.open() as f:
        for line in f:
            if line.strip():
                last = line
    if last is None:
        return 1
    try:
        prev_seq = json.loads(last)["seq"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise ValueError(
            f"corrupt last line in {log_path}: {exc}; refusing to append"
        ) from exc
    if not isinstance(prev_seq, int):
        raise ValueError(
            f"non-integer seq in last line of {log_path}: {prev_seq!r}"
        )
    return prev_seq + 1


def append_stage(
    log_path: pathlib.Path,
    *,
    iter_label: str,
    stage: str,
    status: str,
    summary: str,
    duration_sec: int,
    context_tokens: int = 0,
) -> None:
    """Append one stage event. Caller is responsible for measuring duration.

    Raises:
        TypeError: any argument has the wrong type.
        ValueError: any argument is empty, out-of-range, or otherwise invalid.
    """
    if not isinstance(log_path, pathlib.Path):
        raise TypeError(
            f"log_path must be pathlib.Path, got {type(log_path).__name__}"
        )
    if not isinstance(iter_label, str) or not iter_label:
        raise ValueError(f"iter_label must be a non-empty string, got {iter_label!r}")
    if not isinstance(stage, str) or not stage:
        raise ValueError(f"stage must be a non-empty string, got {stage!r}")
    if stage not in _VALID_STAGES:
        raise ValueError(
            f"stage must be one of {sorted(_VALID_STAGES)}, got {stage!r}"
        )
    if status not in _VALID_STATUSES:
        raise ValueError(
            f"status must be one of {sorted(_VALID_STATUSES)}, got {status!r}"
        )
    if not isinstance(summary, str) or not summary:
        raise ValueError(f"summary must be a non-empty string, got {summary!r}")
    if not isinstance(duration_sec, int) or isinstance(duration_sec, bool):
        raise TypeError(
            f"duration_sec must be int, got {type(duration_sec).__name__}"
        )
    if duration_sec < 0:
        raise ValueError(f"duration_sec must be >= 0, got {duration_sec}")
    if not isinstance(context_tokens, int) or isinstance(context_tokens, bool):
        raise TypeError(
            f"context_tokens must be int, got {type(context_tokens).__name__}"
        )
    if context_tokens < 0:
        raise ValueError(f"context_tokens must be >= 0, got {context_tokens}")

    log_path.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "seq": next_seq(log_path),
        "ts": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        ),
        "iter": iter_label,
        "stage": stage,
        "status": status,
        "summary": summary,
        "duration_sec": duration_sec,
        "context_tokens": context_tokens,
    }
    with log_path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Append one stage event to results/loop_log.jsonl.",
    )
    parser.add_argument(
        "--log-path",
        required=True,
        type=pathlib.Path,
        help="Absolute path to results/loop_log.jsonl",
    )
    parser.add_argument(
        "--iter-label",
        required=True,
        help='"baseline" or "iter1", "iter2", ...',
    )
    parser.add_argument(
        "--stage",
        required=True,
        choices=sorted(_VALID_STAGES),
        help="Pipeline stage that just finished",
    )
    parser.add_argument(
        "--status",
        required=True,
        choices=sorted(_VALID_STATUSES),
        help="ok on success, error on hard stop / unrecoverable failure",
    )
    parser.add_argument(
        "--summary",
        required=True,
        help="One-line outcome (<= 120 chars recommended)",
    )
    parser.add_argument(
        "--duration-sec",
        required=True,
        type=int,
        help="Stage wall-clock duration in seconds",
    )
    parser.add_argument(
        "--context-tokens",
        required=False,
        default=0,
        type=int,
        help=(
            "Placeholder; defaults to 0. Real per-stage values are filled in by "
            "scripts/align_token_usage.py after the loop."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        append_stage(
            args.log_path,
            iter_label=args.iter_label,
            stage=args.stage,
            status=args.status,
            summary=args.summary,
            duration_sec=args.duration_sec,
            context_tokens=args.context_tokens,
        )
    except (TypeError, ValueError) as exc:
        print(f"log_stage: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
