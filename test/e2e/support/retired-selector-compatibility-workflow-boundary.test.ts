// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown>;
type MutableWorkflow = ReturnType<typeof readWorkflow> & {
  jobs: Record<string, { if?: unknown; steps?: WorkflowStep[] }>;
};

function requiredStep(
  steps: WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
  description: string,
): WorkflowStep {
  return (
    steps.find(predicate) ??
    (() => {
      throw new Error(`${description} step is required`);
    })()
  );
}

function compatibilitySteps(): {
  steps: WorkflowStep[];
  workflow: MutableWorkflow;
} {
  const workflow = readWorkflow() as MutableWorkflow;
  const steps =
    workflow.jobs["retired-selector-compatibility"]?.steps ??
    (() => {
      throw new Error("retired-selector-compatibility steps are required");
    })();
  return { steps, workflow };
}

const DRIFT_CASES = [
  {
    name: "target selector gate",
    mutate: (_steps: WorkflowStep[], workflow: MutableWorkflow) => {
      const job = workflow.jobs["retired-selector-compatibility"] as WorkflowStep;
      job.if = String(job.if).replace(
        " || contains(format(',{0},', inputs.targets), ',upgrade-stale-sandbox,')",
        "",
      );
    },
    error: "retired-selector-compatibility job selector gate must match retired selector contract",
  },
  {
    name: "candidate checkout",
    mutate: (steps: WorkflowStep[], _workflow: MutableWorkflow) => {
      const checkout = requiredStep(
        steps,
        (step) => String(step.uses).startsWith("actions/checkout@"),
        "candidate checkout",
      );
      steps.splice(steps.indexOf(checkout), 1);
    },
    error: "retired-selector-compatibility job must check out the candidate revision",
  },
  {
    name: "replacement helper",
    mutate: (steps: WorkflowStep[], _workflow: MutableWorkflow) => {
      const step = requiredStep(
        steps,
        (candidate) => candidate.name === "Verify retired selector replacements",
        "replacement helper",
      );
      step.run = "echo skipped";
    },
    error: "retired-selector-compatibility job must invoke the replacement helper",
  },
  {
    name: "target selector forwarding",
    mutate: (steps: WorkflowStep[], _workflow: MutableWorkflow) => {
      const step = requiredStep(
        steps,
        (candidate) => candidate.name === "Verify retired selector replacements",
        "replacement helper",
      );
      delete (step.env as Record<string, unknown>).TARGETS;
    },
    error: "retired-selector-compatibility job must forward target selectors",
  },
  {
    name: "compatibility artifact upload",
    mutate: (steps: WorkflowStep[], _workflow: MutableWorkflow) => {
      const step = requiredStep(
        steps,
        (candidate) => candidate.name === "Upload retired selector compatibility evidence",
        "compatibility artifact upload",
      );
      step.uses = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
    },
    error: "retired-selector-compatibility job must upload compatibility evidence",
  },
] as const;

it.each(DRIFT_CASES)("rejects retired-selector compatibility drift in $name (#7615)", ({
  mutate,
  error,
}) => {
  const { steps, workflow } = compatibilitySteps();
  mutate(steps, workflow);

  expect(validateE2eWorkflow(workflow)).toContain(error);
});
