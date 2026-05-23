#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Extract text payloads from `openclaw agent --json` output.

OpenClaw has emitted both of these envelopes across recent versions:

  {"result": {"payloads": [{"text": "..."}]}}
  {"payloads": [{"text": "..."}]}

The E2E smoke checks only need the joined assistant text. Invalid JSON is a
real harness failure and exits nonzero; valid JSON with no text prints nothing.
"""

from __future__ import annotations

import json
import sys
from typing import Any


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
    print("\n".join(parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
