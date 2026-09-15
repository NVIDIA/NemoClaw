// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import {
  addedJavaScriptViolations,
  diagnostics,
  dockerfileBudgetGrowthViolations,
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
}

describe("codebase growth guardrails", defineCodebaseGrowthGuardrails);
