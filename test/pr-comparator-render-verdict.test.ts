// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const renderer = path.join(
  process.cwd(),
  ".agents/skills/nemoclaw-maintainer-pr-comparator/scripts/render-verdict.py",
);

const passingGates = {
  state_open: true,
  ci_green_latest_sha: true,
  mergeable: true,
  contributor_compliance: true,
  branch_protection: true,
  pr_advisor_merge_as_is: true,
  coderabbit_threads_resolved: true,
};

function specFor(tier0: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    issue: 9999,
    criteria: [],
    prs: [
      {
        number: 123,
        title: "candidate",
        tier_0: tier0,
        tier_1: {},
        tier_2: {},
      },
    ],
    winner: null,
    closest_to_ready: null,
    ...overrides,
  };
}

function render(spec: unknown) {
  return spawnSync("python3", [renderer], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(spec),
  });
}

describe("PR comparator verdict renderer", () => {
  it("renders contributor compliance and merges only an eligible winner", () => {
    const result = render(specFor(passingGates, { mode: "happy", winner: 123 }));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("| Contributor compliance | pass |");
    expect(result.stdout).toContain("### Verdict: MERGE PR #123");
  });

  it("rejects a supplied winner if contributor compliance failed", () => {
    const result = render(
      specFor({ ...passingGates, contributor_compliance: false }, { mode: "happy", winner: 123 }),
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("winner PR #123 did not pass every Tier 0 gate");
  });

  it("rejects a supplied winner unless the PR Advisor recommends merge as-is", () => {
    const result = render(
      specFor({ ...passingGates, pr_advisor_merge_as_is: false }, { mode: "happy", winner: 123 }),
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("winner PR #123 did not pass every Tier 0 gate");
  });

  it.each([
    ["missing", (({ pr_advisor_merge_as_is: _omitted, ...gates }) => gates)(passingGates)],
    ["non-boolean", { ...passingGates, pr_advisor_merge_as_is: "merge_as_is" }],
    ["unknown", { ...passingGates, invented_gate: true }],
  ])("rejects %s Tier 0 gate data", (_label, gates) => {
    const result = render(specFor(gates));

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid verdict spec");
  });

  it("rejects a supplied mode that contradicts derived eligibility", () => {
    const result = render(
      specFor(
        { ...passingGates, ci_green_latest_sha: false },
        { mode: "happy", closest_to_ready: 123 },
      ),
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("contradicts derived mode 'degraded'");
  });

  it("uses closest_to_ready for an eligible degraded-mode salvage candidate", () => {
    const result = render(
      specFor(
        { ...passingGates, ci_green_latest_sha: false },
        { mode: "degraded", closest_to_ready: 123 },
      ),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### Verdict: Neither mergeable yet");
    expect(result.stdout).toContain("PR #123 is closer to ready.");
    expect(result.stdout).not.toContain("MERGE PR");
  });

  it("rejects a noncompliant degraded-mode salvage candidate", () => {
    const result = render(
      specFor(
        { ...passingGates, contributor_compliance: false },
        { mode: "degraded", closest_to_ready: 123 },
      ),
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be open and contributor-compliant");
  });

  it("keeps the generation instructions aligned with renderer eligibility", () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), ".agents/skills/nemoclaw-maintainer-pr-comparator/SKILL.md"),
      "utf8",
    );

    for (const gate of Object.keys(passingGates)) {
      expect(skill).toContain(`\`${gate}\``);
    }
    expect(skill).toContain("set `winner` only to a PR in that set");
    expect(skill).toContain("use `closest_to_ready` only for an open, contributor-compliant");
    expect(skill).toContain("do not render or recommend a merge if it exits nonzero");
  });
});
