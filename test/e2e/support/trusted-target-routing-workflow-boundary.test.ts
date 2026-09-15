// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type E2eWorkflow = {
  jobs: Record<
    string,
    {
      steps: Array<{
        env?: Record<string, string>;
        id?: string;
        name?: string;
        run?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

describe("trusted E2E planning boundary", () => {
  it.each([
    ["ref", "${{ inputs.checkout_sha }}"],
    ["repository", "${{ inputs.checkout_repository }}"],
    ["persist-credentials", true],
  ] as const)("rejects a trusted planner checkout with changed %s", (key, value) => {
    const workflow = readWorkflow() as E2eWorkflow;
    const checkout = workflow.jobs["generate-matrix"]!.steps.find(
      (step) => step.name === "Check out trusted E2E planner",
    )!;
    const validationError =
      "trusted E2E planner checkout must use the workflow commit without credentials";
    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);

    checkout.with![key] = value;

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });

  it("rejects candidate checkout before trusted planning finishes", () => {
    const workflow = readWorkflow() as E2eWorkflow;
    const steps = workflow.jobs["generate-matrix"]!.steps;
    const candidate = steps.find((step) => step.name === "Check out E2E candidate")!;
    const validationError =
      "trusted E2E planning must finish before candidate checkout and execution";
    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);

    steps.splice(steps.indexOf(candidate), 1);
    steps.splice(
      steps.findIndex((step) => step.name === "Generate E2E target matrix"),
      0,
      candidate,
    );

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });

  it("rejects an inference credential exposed to an unauthorized PR candidate", () => {
    const workflow = readWorkflow() as E2eWorkflow;
    const run = workflow.jobs.live!.steps.find((step) => step.name === "Run live E2E tests")!;
    const validationError =
      "live E2E step must guard NVIDIA_INFERENCE_API_KEY behind a trusted main run or an authorized NVIDIA-owned PR dispatch";

    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);
    run.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });
});
