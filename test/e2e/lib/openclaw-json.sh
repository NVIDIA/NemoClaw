#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Extract human-readable assistant text from `openclaw agent --json` output.
# OpenClaw's JSON envelope has moved between result.payloads[] and top-level
# payloads[]; keep E2E assertions focused on visible reply text instead of one
# exact envelope shape. This also tolerates wrapper output before the JSON blob
# but intentionally ignores metadata fields so IDs, durations, session names,
# and model/provider details cannot satisfy reply assertions.
e2e_text_contains_integer_42() {
  local compact
  compact="$(printf '%s' "${1:-}" | tr -d '[:space:]')"
  grep -qE '(^|[^0-9])42([^0-9]|$)' <<<"$compact"
}

parse_openclaw_agent_text() {
  python3 -c '
import json
import sys

raw = sys.stdin.read()
if not raw.strip():
    sys.exit(0)

parts = []
visited = set()

TEXT_KEYS = {"text", "content", "reasoning_content"}
CONTAINER_KEYS = {
    "result", "payloads", "payload", "messages", "choices", "response",
    "data", "output", "outputs", "items", "segments", "delta",
}


def add(value):
    if isinstance(value, str) and value.strip():
        parts.append(value.strip())


def collect(value):
    value_id = id(value)
    if value_id in visited:
        return
    visited.add(value_id)

    if isinstance(value, str):
        add(value)
        return
    if isinstance(value, list):
        for item in value:
            collect(item)
        return
    if not isinstance(value, dict):
        return

    for key in TEXT_KEYS:
        add(value.get(key))

    # OpenAI-style choices can nest assistant text under message/delta objects.
    for choice in value.get("choices") or []:
        if isinstance(choice, dict):
            collect(choice.get("message"))
            collect(choice.get("delta"))
            add(choice.get("text"))

    for key in CONTAINER_KEYS:
        if key in value:
            collect(value[key])


def collect_from_doc(doc):
    if isinstance(doc, dict) and isinstance(doc.get("result"), dict):
        collect(doc["result"])
    else:
        collect(doc)

try:
    collect_from_doc(json.loads(raw))
except Exception:
    decoder = json.JSONDecoder()
    for idx, char in enumerate(raw):
        if char != "{":
            continue
        try:
            doc, _end = decoder.raw_decode(raw[idx:])
        except Exception:
            continue
        before = len(parts)
        collect_from_doc(doc)
        if len(parts) > before:
            break

print("\n".join(parts))
'
}

openclaw_agent_text_has_integer_42() {
  python3 -c '
import re
import sys

text = sys.stdin.read()
compact = re.sub(r"\s+", "", text)
sys.exit(0 if re.search(r"(^|[^0-9])42([^0-9]|$)", compact) else 1)
'
}

openclaw_agent_text_has_token() {
  local expected="$1"
  EXPECTED="$expected" python3 -c '
import os
import re
import sys

expected = re.sub(r"\s+", "", os.environ.get("EXPECTED", ""))
text = re.sub(r"\s+", "", sys.stdin.read())
sys.exit(0 if expected and expected in text else 1)
'
}
