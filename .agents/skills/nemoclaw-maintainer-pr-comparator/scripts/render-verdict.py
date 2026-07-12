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
    "closest_to_ready": null,
    "mode": "happy"  // optional assertion; derived from Tier 0 gates
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

TIER_0_GATES = (
    ("state_open", "State open"),
    ("ci_green_latest_sha", "CI green on latest SHA"),
    ("mergeable", "Mergeable"),
    ("contributor_compliance", "Contributor compliance"),
    ("branch_protection", "Branch protection"),
    ("pr_advisor_merge_as_is", "PR Review Advisor: merge as-is"),
    ("coderabbit_threads_resolved", "Automated-review threads resolved"),
)
TIER_0_KEYS = tuple(key for key, _label in TIER_0_GATES)
INVALID_SPEC_EXIT = 64


class SpecValidationError(ValueError):
    """Raised when a verdict spec cannot produce a safe recommendation."""


def validate_spec(spec: Any) -> tuple[str, int | None]:
    """Validate untrusted renderer input and derive the verdict mode."""
    if not isinstance(spec, dict):
        raise SpecValidationError("top-level value must be an object")

    prs = spec.get("prs")
    if not isinstance(prs, list) or not prs:
        raise SpecValidationError("prs must be a non-empty array")

    pr_numbers: set[int] = set()
    eligible_numbers: set[int] = set()
    salvageable_numbers: set[int] = set()
    for index, pr in enumerate(prs):
        if not isinstance(pr, dict):
            raise SpecValidationError(f"prs[{index}] must be an object")
        number = pr.get("number")
        if type(number) is not int:
            raise SpecValidationError(f"prs[{index}].number must be an integer")
        if number in pr_numbers:
            raise SpecValidationError(f"duplicate PR number: {number}")
        pr_numbers.add(number)

        gates = pr.get("tier_0")
        if not isinstance(gates, dict):
            raise SpecValidationError(f"PR #{number} tier_0 must be an object")
        missing = [key for key in TIER_0_KEYS if key not in gates]
        extra = sorted(set(gates) - set(TIER_0_KEYS))
        if missing:
            raise SpecValidationError(
                f"PR #{number} tier_0 is missing required gates: {', '.join(missing)}"
            )
        if extra:
            raise SpecValidationError(f"PR #{number} tier_0 has unknown gates: {', '.join(extra)}")
        non_boolean = [key for key in TIER_0_KEYS if type(gates[key]) is not bool]
        if non_boolean:
            raise SpecValidationError(
                f"PR #{number} tier_0 gates must be boolean: {', '.join(non_boolean)}"
            )

        if all(gates[key] for key in TIER_0_KEYS):
            eligible_numbers.add(number)
        if gates["state_open"] and gates["contributor_compliance"]:
            salvageable_numbers.add(number)

    mode = "happy" if eligible_numbers else "degraded"
    winner = spec.get("winner")
    if winner is not None:
        if type(winner) is not int or winner not in pr_numbers:
            raise SpecValidationError("winner must reference a candidate PR number")
        if winner not in eligible_numbers:
            raise SpecValidationError(f"winner PR #{winner} did not pass every Tier 0 gate")

    closest_to_ready = spec.get("closest_to_ready")
    if closest_to_ready is not None:
        if type(closest_to_ready) is not int or closest_to_ready not in pr_numbers:
            raise SpecValidationError("closest_to_ready must reference a candidate PR number")
        if mode != "degraded":
            raise SpecValidationError("closest_to_ready is only valid in degraded mode")
        if closest_to_ready not in salvageable_numbers:
            raise SpecValidationError(
                f"closest_to_ready PR #{closest_to_ready} must be open and contributor-compliant"
            )

    supplied_mode = spec.get("mode")
    if supplied_mode is not None and supplied_mode != mode:
        raise SpecValidationError(
            f"supplied mode {supplied_mode!r} contradicts derived mode {mode!r}"
        )

    return mode, closest_to_ready


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
    for key, label in TIER_0_GATES:
        row = [label]
        for pr in prs:
            row.append(status_emoji(pr["tier_0"][key]))
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
        return INVALID_SPEC_EXIT

    try:
        mode, closest_to_ready = validate_spec(spec)
    except SpecValidationError as e:
        print(f"Invalid verdict spec: {e}", file=sys.stderr)
        return INVALID_SPEC_EXIT

    issue = spec["issue"]
    criteria = spec.get("criteria", [])
    prs = spec.get("prs", [])
    winner = spec.get("winner")
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
        if closest_to_ready is not None:
            print(f"PR #{closest_to_ready} is closer to ready.\n")
        else:
            print("No open, contributor-compliant PR is eligible for salvage.\n")

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
