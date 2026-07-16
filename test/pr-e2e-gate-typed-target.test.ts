// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRiskPlan, PR_E2E_TYPED_TARGET_IDS } from "../tools/advisors/risk-plan.mts";
import {
  classifyPrGateEvidence,
  dispatchPrGate,
  type PrGateState,
  validatePrGateState,
  validateSignal,
} from "../tools/e2e/pr-e2e-gate.mts";
import type { E2eRiskSignal } from "../tools/e2e/risk-signal.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
const DCODE_TARGET = PR_E2E_TYPED_TARGET_IDS[0];
const DCODE_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh";

function state(): PrGateState {
  const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: [DCODE_CHECK] });
  return {
    version: 3,
    commitSha: HEAD_SHA,
    baseSha: BASE_SHA,
    workflowSha: WORKFLOW_SHA,
    planHash: plan.planHash,
    correlationId: CORRELATION_ID,
    prNumber: 42,
    expectedJobs: [],
    expectedTargets: [DCODE_TARGET],
    expectedShards: { [DCODE_TARGET]: ["default"] },
  };
}

function signal(gate: PrGateState, overrides: Partial<E2eRiskSignal> = {}): E2eRiskSignal {
  return {
    version: 1,
    jobId: DCODE_TARGET,
    shardId: "default",
    expectedSha: gate.commitSha,
    testedSha: gate.commitSha,
    planHash: gate.planHash,
    correlationId: gate.correlationId,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "passed",
    ...overrides,
  };
}

describe("PR E2E typed-target gate (#7031)", () => {
  it("requires complete bound evidence for a target-only state", () => {
    const gate = state();
    const target = signal(gate);
    const classify = (signals: E2eRiskSignal[]) =>
      classifyPrGateEvidence({
        workflowConclusion: "success",
        expectedJobs: gate.expectedJobs,
        expectedTargets: gate.expectedTargets,
        expectedShards: gate.expectedShards,
        signals,
      });

    expect(validatePrGateState(gate)).toEqual(gate);
    expect(validateSignal(target, gate)).toEqual(target);
    expect(classify([target]).conclusion).toBe("success");
    expect(classify([]).title).toBe("Evidence is missing");
    expect(classify([signal(gate, { skipped: 1 })]).title).toBe("Evidence is incomplete");
    expect(classify([target, target]).title).toBe("Duplicate evidence");
  });

  it("rejects an unapproved target before dispatch", async () => {
    await expect(
      dispatchPrGate({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: [],
        targets: ["ubuntu-repo-cloud-openclaw"],
        prNumber: 42,
        commitSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        planHash: "c".repeat(64),
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(/Controller dispatch inputs are invalid/u);
  });
});
