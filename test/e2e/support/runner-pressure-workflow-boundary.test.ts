// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateRunnerPressureWorkflow } from "../../../tools/e2e/runner-pressure-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown> & { if?: string; name?: string; run?: string };
type WorkflowJob = { steps: WorkflowStep[] };
type Workflow = { jobs: Record<string, WorkflowJob> };

const JOBS = ["rebuild-hermes", "rebuild-hermes-stale-base"] as const;

function loadWorkflow(): Workflow {
  return readWorkflow() as Workflow;
}

function runStep(workflow: Workflow, jobId: (typeof JOBS)[number]): WorkflowStep {
  return workflow.jobs[jobId]!.steps.find((step) => step.name?.startsWith("Run Hermes"))!;
}

describe("runner-pressure E2E workflow boundary (#7146)", () => {
  it("accepts the canonical Hermes heartbeat and terminal-consumer wiring", () => {
    expect(validateRunnerPressureWorkflow(loadWorkflow())).toEqual([]);
  });

  it.each([
    {
      label: "snapshot and phase baselines",
      mutate: (script: string) =>
        script
          .replace("runner-pressure.mts snapshot", "runner-pressure.mts omitted-snapshot")
          .replace("runner-pressure.mts initialize-evidence", "runner-pressure.mts baseline")
          .replace("E2E_RESOURCE_PHASE_BASELINES_FILE", "OMITTED_PHASE_BASELINES_FILE"),
      error:
        "must emit snapshots and retain immutable workflow plus append-only phase baselines before its live test",
    },
    {
      label: "terminal classification consumer",
      mutate: (script: string) =>
        script.replace(
          "runner-pressure.mts validate-classification",
          "runner-pressure.mts omitted-validation",
        ),
      error:
        "must fail closed on a missing or malformed terminal classification while preserving the live-test status",
    },
    {
      label: "trusted assertion and timeout outcome propagation",
      mutate: (script: string) =>
        script.replace("E2E_TEST_OUTCOME_FILE", "OMITTED_TEST_OUTCOME_FILE"),
      error:
        "must propagate the trusted live-harness assertion or timeout outcome into terminal classification",
    },
  ])("rejects missing $label in both representative lanes", ({ mutate, error }) => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const step = runStep(workflow, jobId);
      step.run = mutate(step.run!);
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map((jobId) => `${jobId} ${error}`),
    );
  });

  it("rejects the old constant none outcome in both representative lanes", () => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const step = runStep(workflow, jobId);
      step.run = step.run!.replace(
        "npx tsx tools/e2e/runner-pressure.mts classify",
        "TEST_OUTCOME=none npx tsx tools/e2e/runner-pressure.mts classify",
      );
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map(
        (jobId) =>
          `${jobId} must propagate the trusted live-harness assertion or timeout outcome into terminal classification`,
      ),
    );
  });

  it("rejects outcome-dependent evidence uploads", () => {
    const workflow = loadWorkflow();
    for (const jobId of JOBS) {
      const upload = workflow.jobs[jobId]!.steps.find((step) =>
        step.name?.startsWith("Upload Hermes"),
      )!;
      upload.if = "success()";
    }

    expect(validateRunnerPressureWorkflow(workflow)).toEqual(
      JOBS.map((jobId) => `${jobId} must upload runner-pressure evidence after every outcome`),
    );
  });
});
