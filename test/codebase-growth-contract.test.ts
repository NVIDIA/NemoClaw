// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { evaluateCurrentTestFileSizeBudget } from "../scripts/check-test-file-size-budget.mts";
import {
  evaluateCurrentJavaScriptContract,
  evaluateCurrentOnboardContract,
  evaluateCurrentTestConditionalContract,
} from "../tools/growth-guardrails/codebase-contract.mts";

function expectNoViolations(violations: readonly unknown[]): void {
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

it("keeps JavaScript files within the existing-file allowance", () => {
  expectNoViolations(evaluateCurrentJavaScriptContract());
});

it("keeps the onboard entrypoint at its ratcheted line budget", () => {
  expectNoViolations(evaluateCurrentOnboardContract());
});

it("keeps test files within their line budgets", () => {
  expectNoViolations(evaluateCurrentTestFileSizeBudget());
});

it("keeps test-file if-statement counts at their ratcheted budgets", () => {
  expectNoViolations(evaluateCurrentTestConditionalContract());
});
