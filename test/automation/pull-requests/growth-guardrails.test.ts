// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import {
  addedJavaScriptViolations,
  conditionalGrowthViolations,
  diagnostics,
  dockerfileBudgetGrowthViolations,
  e2eAssertionBudgetGrowthViolations,
  loopGrowthViolations,
  onboardGrowthViolations,
  testSizeViolations,
} from "../../helpers/growth-guardrail-checks";
import {
  type GrowthGuardrailDiff,
  loadGrowthGuardrailDiff,
} from "../../helpers/growth-guardrail-diff";

/** Register repository-diff assertions that enforce each codebase growth ratchet. */
function defineCodebaseGrowthGuardrails(): void {
  let diff: GrowthGuardrailDiff;

  beforeAll(async () => {
    diff = await loadGrowthGuardrailDiff();
  });

  it("requires TypeScript for new Node.js files", () => {
    const violations = addedJavaScriptViolations(diff.files);
    expect(violations, diagnostics.javascript(violations)).toEqual([]);
  });

  it("keeps src/lib/onboard.ts net-neutral or smaller", async () => {
    const violations = await onboardGrowthViolations(diff);
    expect(violations, diagnostics.onboard(violations)).toEqual([]);
  });

  /** Active managed-image production does not exempt the deprecated host-build recipe. */
  async function enforceCurrentDockerfileBudget(): Promise<void> {
    const violations = await dockerfileBudgetGrowthViolations(diff);
    expect(violations, diagnostics.dockerfileBudget(violations)).toEqual([]);
  }

  it("keeps the root Dockerfile within its ratcheted budget", enforceCurrentDockerfileBudget);

  it("keeps changed test files within the size budget", async () => {
    const violations = await testSizeViolations(diff);
    expect(violations, diagnostics.size(violations)).toEqual([]);
  });

  it("does not increase the live E2E assertion baseline", async () => {
    const violations = await e2eAssertionBudgetGrowthViolations(diff);
    expect(violations, diagnostics.e2eAssertions(violations)).toEqual([]);
  });

  it("does not add if statements to changed test files", async () => {
    const violations = await conditionalGrowthViolations(diff);
    expect(violations, diagnostics.conditionals(violations)).toEqual([]);
  }, 60_000);

  it("does not add test loops directly, through one-use helpers, or through callback-forwarding helpers", async () => {
    const violations = await loopGrowthViolations(diff);
    expect(violations, diagnostics.loops(violations)).toEqual([]);
  }, 60_000);
}

describe("codebase growth guardrails", defineCodebaseGrowthGuardrails);
