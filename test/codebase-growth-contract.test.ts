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

it("does not add JavaScript files", () => {
  expectNoViolations(evaluateCurrentJavaScriptContract());
});

it("does not increase the onboarding entry point line count", () => {
  expectNoViolations(evaluateCurrentOnboardContract());
});

it("keeps test files within their line budgets", () => {
  expectNoViolations(evaluateCurrentTestFileSizeBudget());
});

it("does not add if statements to changed test files", () => {
  expectNoViolations(evaluateCurrentTestConditionalContract());
});
