// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type ControllerWorkflow = {
  jobs: Record<
    string,
    { steps: Array<{ env?: Record<string, string>; id?: string; name?: string; run?: string }> }
  >;
};

const EXPECTED_ERROR = "trusted controller matrix must execute the staged controller boundary";

function fixture() {
  const workflow = readWorkflow() as ControllerWorkflow;
  const controllerMatrix = workflow.jobs["generate-matrix"]!.steps.find(
    (step) => step.id === "controller_matrix",
  )!;
  return { controllerMatrix, workflow };
}

describe("trusted E2E target routing boundary (#7824)", () => {
  it("executes target routing only through the staged trusted boundary", () => {
    const { controllerMatrix, workflow } = fixture();
    expect(validateE2eWorkflow(workflow)).not.toContain(EXPECTED_ERROR);
    controllerMatrix.run = "bash scripts/e2e/manual-pr-dispatch.sh controller-matrix";

    expect(validateE2eWorkflow(workflow)).toContain(EXPECTED_ERROR);
  });

  it("rejects an inference credential exposed to an unauthorized PR candidate", () => {
    const { workflow } = fixture();
    const run = workflow.jobs.live!.steps.find((step) => step.name === "Run live E2E tests")!;
    const validationError =
      "live E2E step must guard NVIDIA_INFERENCE_API_KEY behind a trusted main run or an authorized NVIDIA-owned PR dispatch";

    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);
    run.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });
});
