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


def _snippet(value: str, limit: int = 300) -> str:
    squashed = re.sub(r"\s+", " ", value).strip()
    if len(squashed) <= limit:
        return squashed
    return f"{squashed[: limit - 3]}..."


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_strings(item))
        return parts
    if isinstance(value, dict):
        parts = []
        for item in value.values():
            parts.extend(_strings(item))
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

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            line = _tool_failure_line(node)
            if line:
                lines.append(line)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
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
    for doc in docs:
        candidates.extend(_strings(doc))
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


def _payloads(doc: Any) -> list[Any]:
    if not isinstance(doc, dict):
        return []
    top_level = doc.get("payloads")
    if isinstance(top_level, list):
        return top_level
    result = doc.get("result")
    if isinstance(result, dict) and isinstance(result.get("payloads"), list):
        return result["payloads"]
    return []


def _load_agent_json_docs(text: str) -> list[Any]:
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return doc if isinstance(doc, list) else [doc]

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
    except json.JSONDecodeError as err:
        print(f"invalid JSON: {err}", file=sys.stderr)
        return 1

    parts = [
        payload["text"]
        for doc in docs
        for payload in _payloads(doc)
        if isinstance(payload, dict) and isinstance(payload.get("text"), str)
    ]
    print("\n".join([*_collect_provenance(raw, docs), *parts]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
