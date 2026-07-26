#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Redact secret-shaped fields and values from device-state JSON.

Reads a JSON document on stdin, walks dicts and lists, and replaces any field
whose key matches the secret-name shape with [REDACTED]. String values whose
content matches the secret-value shape (JWT, GitHub PAT, OpenAI/NVIDIA/HF
keys, AWS access keys, Slack tokens) are also replaced. Writes the redacted
JSON to stdout. Preserves request IDs, device IDs, client modes, and scope
lists used for diagnosis.
"""

import json
import re
import sys

SECRET_FIELD_RE = re.compile(
    r"(?:^|[._-])(token|tokens|secret|secrets|credential|credentials|"
    r"authorization|authorisation|auth|password|passwd|apikey|api_key|"
    r"access_key|refresh|cookie|cookies|header|headers|bearer)(?:$|[._-])",
    re.IGNORECASE,
)
SECRET_VALUE_RE = re.compile(
    r"^(?:eyJ[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{16,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|"
    r"nvapi-[A-Za-z0-9._-]{12,}|hf_[A-Za-z0-9]{16,}|"
    r"AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{8,})"
)
REDACTED = "[REDACTED]"


def redact(value):
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            if isinstance(key, str) and SECRET_FIELD_RE.search(key):
                clean[key] = REDACTED
            else:
                clean[key] = redact(item)
        return clean
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str) and SECRET_VALUE_RE.match(value):
        return REDACTED
    return value


def main() -> int:
    try:
        raw = sys.stdin.read()
        doc = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"redact-device-state: invalid JSON on stdin: {exc}\n")
        return 1
    json.dump(redact(doc), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
