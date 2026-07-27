// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown>;

function compatibilitySteps(): {
  steps: WorkflowStep[];
  workflow: ReturnType<typeof readWorkflow>;
} {
  const workflow = readWorkflow() as ReturnType<typeof readWorkflow> & {
    jobs: Record<string, { steps?: WorkflowStep[] }>;
  };
  const steps = workflow.jobs["retired-selector-compatibility"]?.steps;
  if (!steps) throw new Error("retired-selector-compatibility steps are required");
  return { steps, workflow };
}

const DRIFT_CASES = [
  {
    name: "candidate checkout",
    mutate: (steps: WorkflowStep[]) => {
      const index = steps.findIndex((step) => String(step.uses).startsWith("actions/checkout@"));
      steps.splice(index, 1);
    },
    error: "retired-selector-compatibility job must check out the candidate revision",
  },
  {
    name: "replacement helper",
    mutate: (steps: WorkflowStep[]) => {
      const step = steps.find(
        (candidate) => candidate.name === "Verify retired selector replacements",
      );
      if (step) step.run = "echo skipped";
    },
    error: "retired-selector-compatibility job must invoke the replacement helper",
  },
  {
    name: "compatibility artifact upload",
    mutate: (steps: WorkflowStep[]) => {
      const step = steps.find(
        (candidate) => candidate.name === "Upload retired selector compatibility evidence",
      );
      if (step) step.uses = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
    },
    error: "retired-selector-compatibility job must upload compatibility evidence",
  },
] as const;

it.each(DRIFT_CASES)("rejects retired-selector compatibility drift in $name (#7615)", ({
  mutate,
  error,
}) => {
  const { steps, workflow } = compatibilitySteps();
  mutate(steps);

  expect(validateE2eWorkflow(workflow)).toContain(error);
});
