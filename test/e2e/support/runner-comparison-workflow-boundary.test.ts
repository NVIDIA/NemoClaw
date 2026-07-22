// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  RUNNER_COMPARISON_COMMAND,
  RUNNER_COMPARISON_FINALIZE_STEP,
  RUNNER_COMPARISON_INITIALIZE_STEP,
  validateRunnerComparisonWorkflow,
  validateRunnerComparisonWorkflowBoundary,
} from "../../../tools/e2e/runner-comparison-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = Record<string, unknown> & {
  "continue-on-error"?: boolean;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
};
type Workflow = {
  jobs: Record<string, { steps: WorkflowStep[]; strategy?: { matrix?: { agent?: unknown[] } } }>;
};

const JOBS = [
  "common-egress-agent",
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
  "mcp-bridge",
] as const;

function loadWorkflow(): Workflow {
  return structuredClone(readWorkflow()) as Workflow;
}

function step(workflow: Workflow, jobId: string, name: string): WorkflowStep {
  const found = workflow.jobs[jobId]!.steps.find((candidate) => candidate.name === name);
  expect(found, `${jobId} is missing ${name}`).toBeDefined();
  return found!;
}

function telemetrySteps(workflow: Workflow, jobId: string): WorkflowStep[] {
  return workflow.jobs[jobId]!.steps.filter((candidate) =>
    candidate.run?.includes("tools/e2e/runner-comparison.mts"),
  );
}

describe("runner comparison E2E workflow boundary (#7145)", () => {
  it("accepts the exact five-execution comparison wiring", () => {
    const workflow = loadWorkflow();

    expect(validateRunnerComparisonWorkflowBoundary(workflow)).toEqual([]);
    expect(JOBS.flatMap((jobId) => telemetrySteps(workflow, jobId))).toHaveLength(8);
    expect(
      3 +
        workflow.jobs["mcp-bridge"]!.strategy!.matrix!.agent!.filter((agent) =>
          ["hermes", "deepagents"].includes(String(agent)),
        ).length,
    ).toBe(5);
  });

  it("requires both measured MCP matrix entries exactly once", () => {
    const workflow = loadWorkflow();
    workflow.jobs["mcp-bridge"]!.strategy!.matrix!.agent = ["openclaw", "hermes", "hermes"];

    expect(validateRunnerComparisonWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "mcp-bridge matrix must contain hermes exactly once for runner comparison telemetry",
        "mcp-bridge matrix must contain deepagents exactly once for runner comparison telemetry",
      ]),
    );
  });

  it("rejects runner comparison consumers outside the four comparison jobs", () => {
    const workflow = loadWorkflow();
    workflow.jobs["shields-config"]!.steps.push(
      structuredClone(telemetrySteps(workflow, "common-egress-agent")[0]!),
    );

    expect(validateRunnerComparisonWorkflow(workflow)).toContain(
      "shields-config must not collect runner comparison telemetry",
    );
  });

  it.each(JOBS)("requires exactly one initialize and one finalize step in %s", (jobId) => {
    const missing = loadWorkflow();
    missing.jobs[jobId]!.steps = missing.jobs[jobId]!.steps.filter(
      (candidate) => candidate.name !== RUNNER_COMPARISON_FINALIZE_STEP,
    );
    expect(validateRunnerComparisonWorkflow(missing)).toContain(
      `${jobId} must invoke runner comparison telemetry exactly twice`,
    );

    const duplicated = loadWorkflow();
    duplicated.jobs[jobId]!.steps.push(
      structuredClone(step(duplicated, jobId, RUNNER_COMPARISON_INITIALIZE_STEP)),
    );
    expect(validateRunnerComparisonWorkflow(duplicated)).toContain(
      `${jobId} must invoke runner comparison telemetry exactly twice`,
    );
  });

  it.each(JOBS)("keeps %s telemetry around the entire post-prepare job", (jobId) => {
    const lateInitialize = loadWorkflow();
    const lateSteps = lateInitialize.jobs[jobId]!.steps;
    const initializeIndex = lateSteps.indexOf(
      step(lateInitialize, jobId, RUNNER_COMPARISON_INITIALIZE_STEP),
    );
    [lateSteps[initializeIndex], lateSteps[initializeIndex + 1]] = [
      lateSteps[initializeIndex + 1]!,
      lateSteps[initializeIndex]!,
    ];
    expect(validateRunnerComparisonWorkflow(lateInitialize)).toContain(
      `${jobId} must initialize runner comparison telemetry immediately after prepare-e2e`,
    );

    const afterPublication = loadWorkflow();
    const publicationSteps = afterPublication.jobs[jobId]!.steps;
    const finalizeIndex = publicationSteps.indexOf(
      step(afterPublication, jobId, RUNNER_COMPARISON_FINALIZE_STEP),
    );
    [publicationSteps[finalizeIndex], publicationSteps[finalizeIndex + 1]] = [
      publicationSteps[finalizeIndex + 1]!,
      publicationSteps[finalizeIndex]!,
    ];
    expect(validateRunnerComparisonWorkflow(afterPublication)).toContain(
      `${jobId} must finalize runner comparison telemetry immediately before artifact scanning or upload`,
    );
  });

  it("rejects weakened trusted-main and always-run guards", () => {
    const workflow = loadWorkflow();
    step(workflow, "common-egress-agent", RUNNER_COMPARISON_INITIALIZE_STEP).if =
      "${{ github.repository == 'NVIDIA/NemoClaw' }}";
    step(workflow, "rebuild-hermes", RUNNER_COMPARISON_FINALIZE_STEP).if =
      "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha == '' }}";

    expect(validateRunnerComparisonWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "common-egress-agent must use the exact trusted initialize telemetry step",
        "rebuild-hermes must use the exact always-run trusted finalize telemetry step",
      ]),
    );
  });

  it("keeps OpenClaw out of both MCP comparison samples", () => {
    const workflow = loadWorkflow();
    for (const name of [RUNNER_COMPARISON_INITIALIZE_STEP, RUNNER_COMPARISON_FINALIZE_STEP]) {
      const comparison = step(workflow, "mcp-bridge", name);
      comparison.if = comparison.if!.replace(
        "(matrix.agent == 'hermes' || matrix.agent == 'deepagents')",
        "(matrix.agent == 'openclaw' || matrix.agent == 'hermes' || matrix.agent == 'deepagents')",
      );
    }

    expect(validateRunnerComparisonWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "mcp-bridge must use the exact trusted initialize telemetry step",
        "mcp-bridge must use the exact always-run trusted finalize telemetry step",
      ]),
    );
  });

  it("rejects invocation shape, mode, and best-effort drift", () => {
    const workflow = loadWorkflow();
    const initialize = step(
      workflow,
      "rebuild-hermes-stale-base",
      RUNNER_COMPARISON_INITIALIZE_STEP,
    );
    initialize["continue-on-error"] = false;
    initialize.run = `${RUNNER_COMPARISON_COMMAND} finalize`;
    initialize.env = { UNREVIEWED: "1" };

    expect(validateRunnerComparisonWorkflow(workflow)).toContain(
      "rebuild-hermes-stale-base must use the exact trusted initialize telemetry step",
    );
  });
});
