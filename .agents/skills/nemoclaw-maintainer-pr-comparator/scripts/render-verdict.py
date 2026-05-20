#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Render a deterministic verdict scorecard for the PR comparator.

Reads a JSON spec on stdin describing the comparison, emits a markdown
report following templates/verdict.md.

Spec shape:
  {
    "issue": 2681,
    "criteria": ["criterion 1", "criterion 2", ...],
    "prs": [
      {
        "number": 2851,
        "title": "...",
        "tier_0": {"state_open": true, "ci_green_latest_sha": true, ...},
        "tier_1": {"test_exercises_bug_path": "pass", "comment_as_spec": "yellow", ...},
        "tier_2": {"description_diff_drift": "pass", ...},
        "matrix": {"criterion 1": "covered", "criterion 2": "missing", ...},
        "evidence": {"tier_1.test_exercises_bug_path": "test/foo.test.ts:42 asserts on X"}
      },
      ...
    ],
    "tier_0_failures": {"2693": ["substantive:ci_failures=1"], ...},
    "supersession_edges": [{"superseder": 2851, "superseded": 2693}],
    "tiebreaker_fired": "smaller_diff",
    "winner": 2851,
    "mode": "happy"  // or "degraded"
  }

Usage:
  scripts/render-verdict.py < spec.json > verdict.md
  cat spec.json | scripts/render-verdict.py
"""

from __future__ import annotations

import json
import sys
from typing import Any

# Tier 1 weight per check (each pass = 2 points, yellow = 1, fail = 0).
TIER_1_WEIGHT = 2.0
# Tier 2 weight per check (each pass = 1 point, yellow = 0.5, fail = 0).
TIER_2_WEIGHT = 1.0


def status_emoji(status: str) -> str:
    """Map a check status to a short label. Matches templates/verdict.md."""
    return {
        "pass": "pass",
        "yellow": "yellow",
        "fail": "fail",
        True: "pass",
        False: "fail",
    }.get(status, str(status))


def score_for(status: str, weight: float) -> float:
    """Convert a check status to its weighted score contribution."""
    if status == "pass":
        return weight
    if status == "yellow":
        return weight * 0.5
    return 0.0


def render_scorecard(prs: list[dict[str, Any]]) -> str:
    """Render the per-PR scorecard table."""
    if not prs:
        return ""

    headers = ["Check"] + [f"PR #{pr['number']}" for pr in prs]

    rows: list[list[str]] = []

    # Tier 0
    rows.append(["**Tier 0 — gates**"] + [""] * len(prs))
    tier_0_keys = [
        "state_open",
        "ci_green_latest_sha",
        "mergeable",
        "branch_protection",
        "coderabbit_threads_resolved",
    ]
    for key in tier_0_keys:
        label = key.replace("_", " ").capitalize()
        row = [label]
        for pr in prs:
            row.append(status_emoji(pr.get("tier_0", {}).get(key, "fail")))
        rows.append(row)

    # Tier 1
    rows.append(["**Tier 1 — correctness**"] + [""] * len(prs))
    tier_1_keys = [
        "test_exercises_bug_path",
        "comment_as_spec",
        "negative_test_coverage",
        "coverage_shape",
        "refactor_vs_behavior",
        "mocking_purity",
    ]
    for key in tier_1_keys:
        label = key.replace("_", " ").capitalize()
        row = [label]
        for pr in prs:
            row.append(status_emoji(pr.get("tier_1", {}).get(key, "fail")))
        rows.append(row)

    # Tier 2
    rows.append(["**Tier 2 — quality**"] + [""] * len(prs))
    tier_2_keys = [
        "description_diff_drift",
        "migration_completion",
        "public_surface_preservation",
        "workaround_vs_root_cause",
    ]
    for key in tier_2_keys:
        label = key.replace("_", " ").capitalize()
        row = [label]
        for pr in prs:
            row.append(status_emoji(pr.get("tier_2", {}).get(key, "fail")))
        rows.append(row)

    # Weighted score row
    score_row = ["**Weighted score**"]
    for pr in prs:
        total = 0.0
        for status in pr.get("tier_1", {}).values():
            total += score_for(status, TIER_1_WEIGHT)
        for status in pr.get("tier_2", {}).values():
            total += score_for(status, TIER_2_WEIGHT)
        max_total = len(tier_1_keys) * TIER_1_WEIGHT + len(tier_2_keys) * TIER_2_WEIGHT
        score_row.append(f"{total:.1f} / {max_total:.1f}")
    rows.append(score_row)

    out = ["| " + " | ".join(headers) + " |"]
    out.append("|" + "|".join(["---"] * len(headers)) + "|")
    for row in rows:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def render_matrix(prs: list[dict[str, Any]], criteria: list[str]) -> str:
    """Render the behavior-coverage matrix."""
    if not criteria or not prs:
        return ""

    headers = ["Criterion"] + [f"PR #{pr['number']}" for pr in prs]
    out = ["| " + " | ".join(headers) + " |"]
    out.append("|" + "|".join(["---"] * len(headers)) + "|")
    for criterion in criteria:
        row = [criterion]
        for pr in prs:
            row.append(pr.get("matrix", {}).get(criterion, "missing"))
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def render_evidence(prs: list[dict[str, Any]]) -> str:
    """Render the reasoning-evidence section."""
    lines = []
    for pr in prs:
        evidence = pr.get("evidence", {})
        if not evidence:
            continue
        lines.append(f"- PR #{pr['number']}:")
        for check, note in sorted(evidence.items()):
            lines.append(f"  - {check}: {note}")
    return "\n".join(lines)


def main() -> int:
    try:
        spec = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON spec on stdin: {e}", file=sys.stderr)
        return 64

    issue = spec["issue"]
    criteria = spec.get("criteria", [])
    prs = spec.get("prs", [])
    winner = spec.get("winner")
    mode = spec.get("mode", "happy")
    tiebreaker = spec.get("tiebreaker_fired")
    supersession = spec.get("supersession_edges", [])

    print(f"## PR Comparison Verdict — Issue #{issue}\n")

    print("### Acceptance Criteria")
    for c in criteria:
        print(f"- [ ] {c}")
    print()

    print("### Per-PR Scorecard\n")
    print(render_scorecard(prs))
    print()

    if criteria:
        print("\n### Behavior Coverage Matrix\n")
        print(render_matrix(prs, criteria))
        print()

    if mode == "happy":
        if winner is None:
            print("\n### Verdict: No clear winner — see scorecard for recommended action\n")
        else:
            print(f"\n### Verdict: MERGE PR #{winner}\n")
    else:
        print("\n### Verdict: Neither mergeable yet\n")
        if winner is not None:
            print(f"PR #{winner} is closer to ready.\n")
        else:
            print("No PR is meaningfully closer; both need substantial salvage.\n")

    print("Reasoning trace:")
    if supersession:
        for edge in supersession:
            print(f"- PR #{edge['superseder']} supersedes PR #{edge['superseded']} (declared in body).")
    if tiebreaker:
        print(f"- Decided by tiebreaker: {tiebreaker}")
    print()

    print("### Reasoning evidence\n")
    print(render_evidence(prs))

    return 0


if __name__ == "__main__":
    sys.exit(main())
