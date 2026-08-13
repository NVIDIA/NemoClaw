#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Redact credential material and incidental PII from verify-stale evidence."""

from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path


REDACTED = "[REDACTED]"

PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
        REDACTED,
    ),
    (
        re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})"),
        REDACTED,
    ),
    (re.compile(r"nvapi-[A-Za-z0-9_-]{20,}", re.IGNORECASE), REDACTED),
    (
        re.compile(r"\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b", re.IGNORECASE),
        REDACTED,
    ),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"), REDACTED),
    (re.compile(r"AKIA[0-9A-Z]{16}"), REDACTED),
    (
        re.compile(r"aws_secret_access_key\s*=\s*\S+", re.IGNORECASE),
        f"aws_secret_access_key={REDACTED}",
    ),
    (
        re.compile(
            r'''^(\s*(?:[><*]\s*)?)(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*(?::|=))[^\n]*''',
            re.IGNORECASE | re.MULTILINE,
        ),
        rf"\1\2 {REDACTED}",
    ),
    (
        re.compile(
            r'''(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*(?::|=))(?!\s*\[REDACTED\])(\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\n,}\]]+)''',
            re.IGNORECASE,
        ),
        rf"\1\2{REDACTED}",
    ),

    (
        re.compile(r"(\bBearer\s+)\S+", re.IGNORECASE),
        rf"\1{REDACTED}",
    ),
    (
        re.compile(r"\b(https?://)[^\s/@]+(?::[^\s/@]*)?@", re.IGNORECASE),
        rf"\1{REDACTED}@",
    ),
    (
        re.compile(
            r"^.*(?:token|secret|password|api[_-]?key|bearer)[^\n]*[:=][^\n]*$",
            re.IGNORECASE | re.MULTILINE,
        ),
        REDACTED,
    ),
    (
        re.compile(
            r"\b[\w.-]+\.(?:nvidia\.internal|nv-internal\.com|nvidia\.dev)\b",
            re.IGNORECASE,
        ),
        REDACTED,
    ),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), REDACTED),
    (re.compile(r"\b[A-Za-z0-9+/]{60,}={0,2}\b"), REDACTED),
    (re.compile(r"/(?:Users|home)/[^/\s]+/"), "~/"),
)


def html_to_text(value: str) -> str:
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(
        r"</?(?:p|div|tr|td|th|li|pre)[^>]*>",
        "\n",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"<[^>]+>", "", value)
    return html.unescape(value)


def redact(value: str) -> str:
    for pattern, replacement in PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", help="Input file; stdin when omitted")
    parser.add_argument("--html", action="store_true", help="Convert HTML to text first")
    args = parser.parse_args()

    if args.path:
        value = Path(args.path).read_text(encoding="utf-8", errors="replace")
    else:
        value = sys.stdin.read()
    if args.html:
        value = html_to_text(value)
    sys.stdout.write(redact(value))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
