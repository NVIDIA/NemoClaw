#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Extract user-visible text from `openclaw agent --json` output.

OpenClaw has emitted both of these envelopes across recent versions:

  {"result": {"payloads": [{"text": "..."}]}}
  {"payloads": [{"text": "..."}]}

The E2E smoke checks usually need the joined assistant text, but tool failures
and untrusted child-agent payloads are also user-visible provenance. Preserve
those markers so a plausible assistant reply cannot hide failed or unverified
work. Invalid JSON is a real harness failure and exits nonzero; valid JSON with
no visible text prints nothing.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

FAILURE_STATUS_VALUES = {"error", "errored", "failed", "failure"}
UNTRUSTED_CHILD_BEGIN = "BEGIN_UNTRUSTED_CHILD_RESULT"
UNTRUSTED_CHILD_END = "END_UNTRUSTED_CHILD_RESULT"
ANSI_OSC_RE = re.compile(r"\x1B\][\s\S]*?(?:\x07|\x1B\\|$)")
ANSI_CSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x07\x0b\x0c\x0e-\x1f\x7f-\x9f]")
PEM_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)
SECRET_PREFIX_RES = (
    re.compile(r"nvapi-[A-Za-z0-9_-]{10,}"),
    re.compile(r"nvcf-[A-Za-z0-9_-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9_-]{10,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"sk-proj-[A-Za-z0-9_-]{10,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}"),
    re.compile(r"A(?:K|S)IA[A-Z0-9]{16}"),
    re.compile(r"hf_[A-Za-z0-9]{10,}"),
    re.compile(r"glpat-[A-Za-z0-9_-]{10,}"),
    re.compile(r"gsk_[A-Za-z0-9]{10,}"),
    re.compile(r"pypi-[A-Za-z0-9_-]{10,}"),
    re.compile(r"\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),
    re.compile(r"\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b"),
)
BEARER_RE = re.compile(r"(Bearer\s+)\S+", re.IGNORECASE)
SECRET_KV_RE = re.compile(
    r"\b([A-Z0-9_.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_.-]*\s*[:=]\s*[\"']?)[^\"'\s;,)]*",
    re.IGNORECASE,
)
TEXT_KEYS = ("text", "content", "reasoning_content", "reasoning")
CONTAINER_KEYS = (
    "result",
    "payloads",
    "payload",
    "messages",
    "message",
    "response",
    "data",
    "output",
    "outputs",
    "items",
    "segments",
    "delta",
)
MAX_HELPER_WALK_NODES = 10_000
MAX_HELPER_WALK_DEPTH = 80


def _new_walk_budget() -> dict[str, Any]:
    return {"nodes": 0, "seen": set()}


def _can_visit(value: Any, depth: int, budget: dict[str, Any]) -> bool:
    if depth > MAX_HELPER_WALK_DEPTH:
        return False
    if budget["nodes"] >= MAX_HELPER_WALK_NODES:
        return False
    budget["nodes"] += 1
    if isinstance(value, (dict, list)):
        marker = id(value)
        if marker in budget["seen"]:
            return False
        budget["seen"].add(marker)
    return True


def _snippet(value: str, limit: int = 300) -> str:
    sanitized = ANSI_OSC_RE.sub("", value)
    sanitized = ANSI_CSI_RE.sub("", sanitized)
    sanitized = sanitized.replace("\r", "").replace("\b", "")
    sanitized = CONTROL_RE.sub("", sanitized)
    squashed = re.sub(r"\s+", " ", sanitized).strip()
    redacted = _redact_secret_text(squashed)
    if len(redacted) <= limit:
        return redacted
    return f"{redacted[: limit - 3]}..."


def _redact_secret_text(value: str) -> str:
    redacted = PEM_PRIVATE_KEY_RE.sub("<REDACTED_PRIVATE_KEY>", value)
    redacted = BEARER_RE.sub(r"\1<REDACTED>", redacted)
    redacted = SECRET_KV_RE.sub(r"\1<REDACTED>", redacted)
    for pattern in SECRET_PREFIX_RES:
        redacted = pattern.sub("<REDACTED>", redacted)
    return redacted


def _strings(value: Any, depth: int = 0, budget: dict[str, Any] | None = None) -> list[str]:
    if budget is None:
        budget = _new_walk_budget()
    if not _can_visit(value, depth, budget):
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_strings(item, depth + 1, budget))
        return parts
    if isinstance(value, dict):
        parts = []
        for item in value.values():
            parts.extend(_strings(item, depth + 1, budget))
        return parts
    return []


def _detail_from_value(value: Any) -> str | None:
    if isinstance(value, str):
        return _snippet(value)
    if isinstance(value, (dict, list)):
        strings = [_snippet(part) for part in _strings(value) if part.strip()]
        if strings:
            return _snippet("; ".join(strings))
        try:
            return _snippet(json.dumps(value, sort_keys=True))
        except TypeError:
            return _snippet(str(value))
    if value is None:
        return None
    return _snippet(str(value))


def _first_detail(record: dict[str, Any]) -> str | None:
    for key in (
        "text",
        "content",
        "message",
        "error",
        "stderr",
        "stdout",
        "output",
        "result",
    ):
        if key in record:
            detail = _detail_from_value(record[key])
            if detail:
                return detail
    return None


def _normalized(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", "-")


def _is_tool_like(record: dict[str, Any]) -> bool:
    role = _normalized(record.get("role"))
    block_type = _normalized(record.get("type"))
    if role == "toolresult" or block_type == "toolresult":
        return True
    if role == "tool-result" or block_type == "tool-result":
        return True
    return any(
        key in record
        for key in (
            "toolCallId",
            "tool_call_id",
            "toolName",
            "tool_name",
            "tool",
        )
    )


def _has_failure_status(record: dict[str, Any]) -> bool:
    if record.get("isError") is True or record.get("is_error") is True:
        return True
    for key in ("status", "state", "finalStatus"):
        if _normalized(record.get(key)) in FAILURE_STATUS_VALUES:
            return True
    return record.get("ok") is False or record.get("success") is False


def _tool_label(record: dict[str, Any]) -> str:
    tool = (
        record.get("toolName")
        or record.get("tool_name")
        or record.get("name")
        or record.get("tool")
    )
    call_id = record.get("toolCallId") or record.get("tool_call_id") or record.get("id")
    parts = [str(part).strip() for part in (tool, call_id) if str(part or "").strip()]
    return " ".join(parts) if parts else "unknown tool"


def _tool_failure_line(record: dict[str, Any]) -> str | None:
    if not _is_tool_like(record) or not _has_failure_status(record):
        return None
    detail = _first_detail(record) or "no failure detail provided"
    return f"[openclaw provenance] failed tool result ({_tool_label(record)}): {detail}"


def _collect_tool_failure_provenance(value: Any) -> list[str]:
    lines: list[str] = []

    def visit(node: Any, depth: int, budget: dict[str, Any]) -> None:
        if not _can_visit(node, depth, budget):
            return
        if isinstance(node, dict):
            line = _tool_failure_line(node)
            if line:
                lines.append(line)
            for child in node.values():
                visit(child, depth + 1, budget)
        elif isinstance(node, list):
            for child in node:
                visit(child, depth + 1, budget)

    visit(value, 0, _new_walk_budget())
    return lines


def _untrusted_child_excerpt(value: str) -> str | None:
    start = value.find(UNTRUSTED_CHILD_BEGIN)
    if start < 0:
        return None
    body = value[start + len(UNTRUSTED_CHILD_BEGIN) :]
    end = body.find(UNTRUSTED_CHILD_END)
    if end >= 0:
        body = body[:end]
    body = body.strip(" <>\n\r\t")
    return _snippet(body) if body else None


def _collect_untrusted_child_provenance(raw: str, docs: list[Any]) -> list[str]:
    candidates: list[str] = []
    budget = _new_walk_budget()
    for doc in docs:
        candidates.extend(_strings(doc, budget=budget))
    candidates.append(raw)
    if not any(UNTRUSTED_CHILD_BEGIN in candidate for candidate in candidates):
        return []

    lines = [
        "[openclaw provenance] untrusted child result present; verify child-sourced data before treating it as confirmed."
    ]
    for candidate in candidates:
        excerpt = _untrusted_child_excerpt(candidate)
        if excerpt:
            lines.append(f"[openclaw provenance] untrusted child excerpt: {excerpt}")
            break
    return lines


def _dedupe(lines: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for line in lines:
        if line in seen:
            continue
        seen.add(line)
        result.append(line)
    return result


def _collect_provenance(raw: str, docs: list[Any]) -> list[str]:
    lines: list[str] = []
    lines.extend(_collect_untrusted_child_provenance(raw, docs))
    for doc in docs:
        lines.extend(_collect_tool_failure_provenance(doc))
    return _dedupe(lines)


def _add_text(parts: list[str], value: Any) -> None:
    if isinstance(value, str) and value.strip():
        parts.append(value.strip())


def _collect_assistant_text(
    value: Any,
    parts: list[str],
    visited: set[int],
    depth: int = 0,
    budget: dict[str, Any] | None = None,
) -> None:
    if budget is None:
        budget = _new_walk_budget()
    if not _can_visit(value, depth, budget):
        return
    if isinstance(value, str):
        _add_text(parts, value)
        return
    if isinstance(value, list):
        marker = id(value)
        if marker in visited:
            return
        visited.add(marker)
        for item in value:
            _collect_assistant_text(item, parts, visited, depth + 1, budget)
        return
    if not isinstance(value, dict):
        return

    marker = id(value)
    if marker in visited:
        return
    visited.add(marker)

    if _is_tool_like(value):
        return

    for key in TEXT_KEYS:
        _add_text(parts, value.get(key))

    choices = value.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            _collect_assistant_text(choice.get("message"), parts, visited, depth + 1, budget)
            _collect_assistant_text(choice.get("delta"), parts, visited, depth + 1, budget)
            _add_text(parts, choice.get("text"))

    for key in CONTAINER_KEYS:
        if key in value:
            _collect_assistant_text(value[key], parts, visited, depth + 1, budget)


def _assistant_text_parts(docs: list[Any]) -> list[str]:
    parts: list[str] = []
    visited: set[int] = set()
    budget = _new_walk_budget()
    for doc in docs:
        if isinstance(doc, dict) and "result" in doc:
            _collect_assistant_text(doc["result"], parts, visited, budget=budget)
        else:
            _collect_assistant_text(doc, parts, visited, budget=budget)
    return parts


def _load_agent_json_docs(text: str) -> list[Any]:
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return doc if isinstance(doc, list) else [doc]

    # Invalid state: upstream OpenClaw has emitted log-prefixed/non-clean JSON
    # framing for `openclaw agent --json`, and sandbox-controlled JSON can be
    # deeply nested. Source boundary: OpenClaw owns the emitter/framing; the host
    # TypeScript parser owns CLI provenance extraction; this E2E helper only
    # preserves legacy smoke-test text/provenance assertions. Source-fix
    # constraint: do not patch OpenClaw or broaden production parser callers from
    # this PR. Regression tests cover log-prefixed streams, later envelopes,
    # OpenAI-style choices, sanitized provenance, and bounded deep traversal.
    # Removal condition: supported OpenClaw versions guarantee stable clean JSON
    # framing on stdout or these shell smoke tests use the host TS parser.
    decoder = json.JSONDecoder()
    docs: list[Any] = []
    index = 0
    while index < len(text):
        start = text.find("{", index)
        if start < 0:
            break
        try:
            doc, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            index = start + 1
            continue
        docs.append(doc)
        index = start + end
    if docs:
        return docs
    raise json.JSONDecodeError("no JSON object found", text, 0)


def main() -> int:
    raw = sys.stdin.read()
    try:
        docs = _load_agent_json_docs(raw)
    except (json.JSONDecodeError, RecursionError) as err:
        print(f"invalid JSON: {err}", file=sys.stderr)
        return 1

    parts = _assistant_text_parts(docs)
    print("\n".join([*_collect_provenance(raw, docs), *parts]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
