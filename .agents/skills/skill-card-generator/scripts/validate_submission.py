#!/usr/bin/env python3
"""
validate_submission.py — Fail if a rendered skill card still contains
unresolved VERIFY or SELECT markers.

This is the engineering substitute for a review UI. A rendered card
leaves the generator with:
  - Red <span style="color:#d73a49"> wrappers + <!-- VERIFY: ... --> comments
    around inferred or defaulted fields (owner, license).
  - Blue <span style="color:#0366d6"> intro lines + <!-- SELECT: name --> /
    <!-- /SELECT --> wrappers around canned catalog entries.

The human reviewer is expected to:
  1. Confirm or edit each VERIFY field, then delete the red span and
     the <!-- VERIFY --> comment.
  2. Inside each SELECT block, delete the canned entries that don't
     apply, add any skill-specific custom entries, then delete the
     blue intro line and the <!-- SELECT --> / <!-- /SELECT --> comments.

This script is a single-pass grep over the rendered markdown that
exits non-zero if any marker (visual or machine-readable) remains.
Run it as the pre-submission gate for NVCARPS.

Usage:
  python3 validate_submission.py <rendered-card.md>

Exit codes:
  0  clean — no markers remain
  1  markers present — reviewer is not done
  2  usage error (missing file, bad args)
"""

import re
import sys
from pathlib import Path


# (pattern, kind, help_on_failure) — kept as a list so the validator
# reports every failing class rather than short-circuiting.
CHECKS = [
    (
        re.compile(r"<!--\s*VERIFY\b"),
        "verify-comment",
        "Confirm or edit each red-highlighted field value, then delete the "
        "`<!-- VERIFY: ... -->` comment and the surrounding "
        '`<span style="color:#d73a49">...</span>` wrapper.',
    ),
    (
        re.compile(r"<!--\s*SELECT:"),
        "select-open",
        "Open `<!-- SELECT: ... -->` marker remains: prune the canned entries "
        "inside the block (delete the lines that don't apply, add any "
        "skill-specific custom entries), then delete both the `<!-- SELECT: -->` "
        "and the matching `<!-- /SELECT -->` comments.",
    ),
    (
        re.compile(r"<!--\s*/SELECT\s*-->"),
        "select-close",
        "Closing `<!-- /SELECT -->` marker remains: see the SELECT block guidance above.",
    ),
    (
        re.compile(r"color:\s*#d73a49", re.IGNORECASE),
        "verify-style",
        'Red verify styling is still present: remove the `<span style="color:#d73a49">...</span>` '
        "wrappers after you have confirmed the inferred field values.",
    ),
    (
        re.compile(r"color:\s*#0366d6", re.IGNORECASE),
        "select-style",
        "Blue select styling is still present: remove the blue intro line "
        '(`<span style="color:#0366d6">...</span>`) after you have pruned each SELECT block.',
    ),
    (
        re.compile(r"^>\s*\*\*Red lines need your verification", re.MULTILINE),
        "legend-red",
        "The red-marker legend line at the top of the card is still present; remove the two legend blockquote lines before submission.",
    ),
    (
        re.compile(r"^>\s*\*\*Blue lines are selectable", re.MULTILINE),
        "legend-blue",
        "The blue-marker legend line at the top of the card is still present; remove the two legend blockquote lines before submission.",
    ),
]


def validate(path: Path) -> list[tuple[str, int, str]]:
    text = path.read_text()
    failures: list[tuple[str, int, str]] = []
    for pattern, kind, help_text in CHECKS:
        hits = pattern.findall(text)
        if hits:
            failures.append((kind, len(hits), help_text))
    return failures


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <rendered-card.md>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 2

    failures = validate(path)
    if not failures:
        print(f"OK: {path} has no unresolved verify/select markers.")
        return 0

    print(f"FAIL: {path} has unresolved verify/select markers:", file=sys.stderr)
    for kind, count, help_text in failures:
        print(f"\n  [{kind}] {count} occurrence(s)", file=sys.stderr)
        print(f"    {help_text}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
