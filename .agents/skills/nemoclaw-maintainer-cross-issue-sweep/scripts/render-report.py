#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Render the cross-issue sweep report from a list of classified candidates.

Reads a JSON spec on stdin describing the sweep, emits markdown matching
templates/report.md.

Spec shape:
  {
    "pr": 2851,
    "pr_title": "...",
    "classifications": [
      {
        "issue_number": 4521,
        "issue_title": "...",
        "class": "ADJACENT_FIX",
        "confidence": "high",
        "reverse_link_boosted": true,
        "evidence": {
          "pr_diff_line": "src/lib/validate.ts:42",
          "issue_symptom": "issue body line 12",
          "reasoning": "..."
        }
      },
      ...
    ],
    "primary_issue": 2681,
    "suppressed": {"unrelated": 7, "same_issue_diff": 2}
  }

Usage:
  scripts/render-report.py < spec.json > report.md
"""

from __future__ import annotations

import json
import sys
from typing import Any


CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def _format_entry(c: dict[str, Any]) -> str:
    """Render one classification line with evidence summary."""
    boost_marker = " [boosted from reverse-link]" if c.get("reverse_link_boosted") else ""
    evidence = c.get("evidence") or {}
    if not isinstance(evidence, dict):
        evidence = {}
    diff_line = evidence.get("pr_diff_line", "?")
    symptom = evidence.get("issue_symptom", "?")
    issue_number = c.get("issue_number", "?")
    confidence = c.get("confidence", "low")
    return (
        f"- **#{issue_number}** ({confidence}{boost_marker}) "
        f"— {diff_line} matches {symptom}\n"
        f"  → {evidence.get('reasoning', '')}"
    )


def _is_valid_classification(c: Any) -> bool:
    """Skip null entries and entries missing the keys downstream code reads."""
    return isinstance(c, dict) and "issue_number" in c and "class" in c


def main() -> int:
    try:
        spec = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON spec on stdin: {e}", file=sys.stderr)
        return 64

    if not isinstance(spec, dict):
        print("Invalid spec: root must be a JSON object", file=sys.stderr)
        return 64
    if "pr" not in spec:
        print("Invalid spec: missing required field 'pr'", file=sys.stderr)
        return 64

    pr = spec["pr"]
    pr_title = spec.get("pr_title", "")
    classifications = spec.get("classifications", [])
    if not isinstance(classifications, list):
        print("Invalid spec: 'classifications' must be a list", file=sys.stderr)
        return 64
    suppressed = spec.get("suppressed", {})
    if not isinstance(suppressed, dict):
        print("Invalid spec: 'suppressed' must be a JSON object", file=sys.stderr)
        return 64

    valid = [c for c in classifications if _is_valid_classification(c)]
    adjacent = sorted(
        [c for c in valid if c.get("class") == "ADJACENT_FIX"],
        key=lambda c: -CONFIDENCE_RANK.get(c.get("confidence", "low"), 0),
    )
    contradicting = sorted(
        [c for c in valid if c.get("class") == "CONTRADICTING"],
        key=lambda c: -CONFIDENCE_RANK.get(c.get("confidence", "low"), 0),
    )

    print(f"## Cross-issue scan — PR #{pr}" + (f" ({pr_title})" if pr_title else ""))
    print()

    if not adjacent and not contradicting:
        print("No adjacent fixes or contradictions found above the medium confidence floor.")
        print()
        unrelated = suppressed.get("unrelated", 0)
        same_issue = suppressed.get("same_issue_diff", 0)
        print(f"Suppressed: {unrelated} unrelated, {same_issue} same-issue duplicates.")
        return 0

    if adjacent:
        print("### Adjacent fixes (PR may also close)")
        print()
        for c in adjacent:
            print(_format_entry(c))
        print()

    if contradicting:
        print("### Contradicting (coordinate before merge)")
        print()
        for c in contradicting:
            print(_format_entry(c))
        print()

    print("### Suppressed")
    print()
    unrelated = suppressed.get("unrelated", 0)
    same_issue = suppressed.get("same_issue_diff", 0)
    print(f"- {unrelated} unrelated candidates")
    print(f"- {same_issue} same-issue duplicates of primary #{spec.get('primary_issue', '?')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
