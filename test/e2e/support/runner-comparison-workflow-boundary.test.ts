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
type WorkflowMatrix = Record<string, unknown> & {
  include?: Array<Record<string, unknown>>;
};
type Workflow = {
  jobs: Record<string, { steps: WorkflowStep[]; strategy?: { matrix?: WorkflowMatrix } }>;
};

const JOBS = [
  "channels-stop-start",
  "common-egress-agent",
  "hermes-dashboard",
  "hermes-discord",
  "hermes-e2e",
  "hermes-inference-switch",
  "hermes-shields-config",
  "mcp-bridge",
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
  "security-posture",
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
  it("accepts 12 routed workflow lane identities / 13 concrete job executions", () => {
    const workflow = loadWorkflow();

    expect(validateRunnerComparisonWorkflowBoundary(workflow)).toEqual([]);
    expect(JOBS.flatMap((jobId) => telemetrySteps(workflow, jobId))).toHaveLength(JOBS.length * 2);

    const mcpAgents = workflow.jobs["mcp-bridge"]!.strategy!.matrix!.agent as unknown[];
    expect(mcpAgents).toEqual(["openclaw", "hermes", "deepagents"]);
    const mcpLanes = mcpAgents.filter((agent) =>
      ["hermes", "deepagents"].includes(String(agent)),
    ).length;
    const inferenceSwitchModes = workflow.jobs[
      "hermes-inference-switch"
    ]!.strategy!.matrix!.include?.map((entry) => entry.mode);
    expect(inferenceSwitchModes).toEqual(["hosted", "anthropic"]);
    const routedLanes = JOBS.length - 1 + mcpLanes;
    const concreteExecutions = routedLanes - 1 + inferenceSwitchModes!.length;
    expect(routedLanes).toBe(12);
    expect(concreteExecutions).toBe(13);
  });

  it("locks the matrix topology that produces thirteen concrete executions", () => {
    const workflow = loadWorkflow();
    workflow.jobs["mcp-bridge"]!.strategy!.matrix!.agent = ["openclaw", "hermes", "hermes"];
    workflow.jobs["channels-stop-start"]!.strategy!.matrix!.agent = ["openclaw", "openclaw"];
    workflow.jobs["security-posture"]!.strategy!.matrix!.include = [
      { agent: "openclaw" },
      { agent: "openclaw" },
    ];
    workflow.jobs["hermes-inference-switch"]!.strategy!.matrix!.include = [
      { mode: "hosted" },
      { mode: "hosted" },
    ];

    expect(validateRunnerComparisonWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "channels-stop-start matrix must contain exactly openclaw, hermes for runner comparison telemetry",
        "mcp-bridge matrix must contain exactly openclaw, hermes, deepagents for runner comparison telemetry",
        "security-posture matrix must contain exactly openclaw, hermes for runner comparison telemetry",
        "hermes-inference-switch matrix must contain exactly hosted, anthropic for runner comparison telemetry",
      ]),
    );
  });

  it("rejects runner comparison consumers outside the eleven comparison jobs", () => {
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

  it("keeps non-routed matrix counterparts out of comparison telemetry", () => {
    const workflow = loadWorkflow();
    for (const name of [RUNNER_COMPARISON_INITIALIZE_STEP, RUNNER_COMPARISON_FINALIZE_STEP]) {
      const comparison = step(workflow, "mcp-bridge", name);
      comparison.if = comparison.if!.replace(
        "(matrix.agent == 'hermes' || matrix.agent == 'deepagents')",
        "(matrix.agent == 'openclaw' || matrix.agent == 'hermes' || matrix.agent == 'deepagents')",
      );
      for (const jobId of ["channels-stop-start", "security-posture"]) {
        const hermesComparison = step(workflow, jobId, name);
        hermesComparison.if = hermesComparison.if!.replace(
          "matrix.agent == 'hermes'",
          "(matrix.agent == 'openclaw' || matrix.agent == 'hermes')",
        );
      }
    }

    expect(validateRunnerComparisonWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "mcp-bridge must use the exact trusted initialize telemetry step",
        "mcp-bridge must use the exact always-run trusted finalize telemetry step",
        "channels-stop-start must use the exact trusted initialize telemetry step",
        "channels-stop-start must use the exact always-run trusted finalize telemetry step",
        "security-posture must use the exact trusted initialize telemetry step",
        "security-posture must use the exact always-run trusted finalize telemetry step",
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
