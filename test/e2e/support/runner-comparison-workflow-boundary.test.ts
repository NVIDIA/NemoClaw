// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  RUNNER_COMPARISON_FINALIZE_STEP,
  RUNNER_COMPARISON_INITIALIZE_STEP,
  validateRunnerComparisonWorkflow,
} from "../../../tools/e2e/runner-comparison-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type Step = { name?: string; if?: string; run?: string };
type Job = { steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

function workflow(): Workflow {
  return readWorkflow() as Workflow;
}

describe("runner comparison workflow boundary", () => {
  it("keeps telemetry on the three retained routed jobs", () => {
    expect(validateRunnerComparisonWorkflow(workflow())).toEqual([]);
  });

  it("requires both telemetry steps in a retained consumer", () => {
    const value = workflow();
    value.jobs["hermes-e2e"]!.steps = value.jobs["hermes-e2e"]!.steps.filter(
      (step) => step.name !== RUNNER_COMPARISON_INITIALIZE_STEP,
    );

    expect(validateRunnerComparisonWorkflow(value)).toContain(
      "hermes-e2e must invoke runner comparison telemetry exactly twice",
    );
  });

  it("rejects telemetry in an unreviewed retained job", () => {
    const value = workflow();
    value.jobs["token-rotation"]!.steps.push({
      name: RUNNER_COMPARISON_INITIALIZE_STEP,
      run: "npx tsx tools/e2e/runner-comparison.mts initialize",
    });

    expect(validateRunnerComparisonWorkflow(value)).toContain(
      "token-rotation must not collect runner comparison telemetry",
    );
  });

  it("keeps finalization best-effort and always-run", () => {
    const value = workflow();
    const finalize = value.jobs["hermes-e2e"]!.steps.find(
      (step) => step.name === RUNNER_COMPARISON_FINALIZE_STEP,
    )!;
    finalize.if = "${{ always() }}";

    expect(validateRunnerComparisonWorkflow(value)).toContain(
      "hermes-e2e must use the exact always-run trusted finalize telemetry step",
    );
  });
});
