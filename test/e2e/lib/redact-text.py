#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Redact token-shaped substrings from arbitrary text streams.

Reads text on stdin, replaces matches for known token shapes (JWT, GitHub PAT,
OpenAI/NVIDIA/HF keys, AWS access keys, Slack tokens, and HTTP Authorization /
Bearer headers and `token=` / `apikey=` style query parameters) with
``[REDACTED]``, then writes the scrubbed text to stdout. Used to scrub
diagnostic log excerpts (gateway, auto-pair) before they are appended to
secret-bearing E2E artefacts.

Secret-shape catalogue extensibility
------------------------------------

Adding a new token shape:

1. Add a branch to ``TOKEN_VALUE_RE`` (whole-token matches; substituted
   wholesale) OR to ``AUTH_HEADER_RE`` / ``BEARER_RE`` / ``QUERY_PARAM_RE``
   (matches keep the structural prefix and redact only the value).
2. Keep the branch as conservative as the existing entries — anchor with
   ``\\b`` or a structural prefix so the pattern never matches inside
   ordinary hyphenated text. The ``\\bsk-`` branch is the canonical
   left-bounded shape; copy that form for new vendor prefixes.
3. Add a positive test (the shape is redacted) AND a regression test (a
   near-miss is preserved) in ``test/redact-text.test.ts``. Both must run
   before merge; ``test/redact-text.test.ts`` is the single home for
   redactor unit coverage.
4. Document the new shape in the file-level paragraph above so reviewers
   know the catalogue surface without reading the regex.

This module intentionally has no external dependencies and no error
paths beyond the regex substitution; stdout is a deterministic function
of stdin. Callers that need a fail-closed marker (e.g. on a transient
subprocess failure) wrap the invocation in
``redact_text_for_log_or_marker`` in
``test/e2e/test-issue-4462-scope-upgrade-approval.sh``.
"""

import re
import sys

TOKEN_VALUE_RE = re.compile(
    r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]+"
    r"|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|github_pat_[A-Za-z0-9_]{20,}"
    r"|\bsk-[A-Za-z0-9_-]{12,}"
    r"|nvapi-[A-Za-z0-9._-]{12,}"
    r"|hf_[A-Za-z0-9]{16,}"
    r"|AKIA[0-9A-Z]{12,}"
    r"|ASIA[0-9A-Z]{12,}"
    r"|xox[abprs]-[A-Za-z0-9-]{8,}"
)
AUTH_HEADER_RE = re.compile(
    r"(?i)((?:authorization|authorisation|x-api-key|api-key|x-auth-token|"
    r"x-nvidia-api-key|x-openrouter-api-key|cookie|set-cookie)"
    r"\s*[:=]\s*(?:Bearer|Token|Basic)?\s*)([^\s,;'\"]+)"
)
BEARER_RE = re.compile(r"(?i)(\b(?:Bearer|Token)\s+)([^\s,;'\"]+)")
QUERY_PARAM_RE = re.compile(
    r"(?i)(\b(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"client[_-]?secret|password|passwd|secret)\s*=\s*)([^\s&'\"]+)"
)
REDACTED = "[REDACTED]"


def redact_line(line: str) -> str:
    cleaned = TOKEN_VALUE_RE.sub(REDACTED, line)
    cleaned = AUTH_HEADER_RE.sub(r"\1" + REDACTED, cleaned)
    cleaned = BEARER_RE.sub(r"\1" + REDACTED, cleaned)
    cleaned = QUERY_PARAM_RE.sub(r"\1" + REDACTED, cleaned)
    return cleaned


def main() -> int:
    text = sys.stdin.read()
    sys.stdout.write("".join(redact_line(line) for line in text.splitlines(keepends=True)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
