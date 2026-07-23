// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { PREPARE_E2E_STEP } from "./prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

export const RUNNER_COMPARISON_INITIALIZE_STEP = "Initialize runner comparison telemetry";
export const RUNNER_COMPARISON_FINALIZE_STEP = "Finalize runner comparison telemetry";
export const RUNNER_COMPARISON_COMMAND = "npx tsx tools/e2e/runner-comparison.mts";

const TRUSTED_MAIN_GUARD =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha == ''";
const HERMES_AGENT_GUARD = "matrix.agent == 'hermes'";
const MCP_AGENT_GUARD = "(matrix.agent == 'hermes' || matrix.agent == 'deepagents')";
const ORDINARY_INITIALIZE_GUARD = `\${{ ${TRUSTED_MAIN_GUARD} }}`;
const ORDINARY_FINALIZE_GUARD = `\${{ always() && ${TRUSTED_MAIN_GUARD} }}`;
const HERMES_INITIALIZE_GUARD = `\${{ ${TRUSTED_MAIN_GUARD} && ${HERMES_AGENT_GUARD} }}`;
const HERMES_FINALIZE_GUARD = `\${{ always() && ${TRUSTED_MAIN_GUARD} && ${HERMES_AGENT_GUARD} }}`;
const MCP_INITIALIZE_GUARD = `\${{ ${TRUSTED_MAIN_GUARD} && ${MCP_AGENT_GUARD} }}`;
const MCP_FINALIZE_GUARD = `\${{ always() && ${TRUSTED_MAIN_GUARD} && ${MCP_AGENT_GUARD} }}`;

const COMPARISON_JOBS: ReadonlyMap<string, { initializeIf: string; finalizeIf: string }> = new Map([
  [
    "channels-stop-start",
    { initializeIf: HERMES_INITIALIZE_GUARD, finalizeIf: HERMES_FINALIZE_GUARD },
  ],
  [
    "common-egress-agent",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  [
    "hermes-dashboard",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  [
    "hermes-discord",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  ["hermes-e2e", { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD }],
  [
    "hermes-inference-switch",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  [
    "hermes-shields-config",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  ["mcp-bridge", { initializeIf: MCP_INITIALIZE_GUARD, finalizeIf: MCP_FINALIZE_GUARD }],
  [
    "rebuild-hermes",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  [
    "rebuild-hermes-stale-base",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  [
    "security-posture",
    { initializeIf: HERMES_INITIALIZE_GUARD, finalizeIf: HERMES_FINALIZE_GUARD },
  ],
]);

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  "continue-on-error"?: boolean;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function matrixValues(jobs: WorkflowRecord, jobId: string, key: string): unknown[] {
  const matrix = record(record(record(jobs[jobId]).strategy).matrix);
  if (Array.isArray(matrix[key])) return matrix[key];
  if (!Array.isArray(matrix.include)) return [];
  return matrix.include.map((entry) => record(entry)[key]);
}

function requireExactMatrixValues(
  errors: string[],
  jobs: WorkflowRecord,
  jobId: string,
  key: string,
  expected: readonly string[],
): void {
  const actual = matrixValues(jobs, jobId, key);
  if (
    actual.length !== expected.length ||
    expected.some((value) => actual.filter((candidate) => candidate === value).length !== 1)
  ) {
    errors.push(
      `${jobId} matrix must contain exactly ${expected.join(", ")} for runner comparison telemetry`,
    );
  }
}

function exactStep(
  step: WorkflowStep,
  name: string,
  condition: string,
  mode: "initialize" | "finalize",
): boolean {
  return isDeepStrictEqual(step, {
    name,
    if: condition,
    "continue-on-error": true,
    shell: "bash",
    run: `${RUNNER_COMPARISON_COMMAND} ${mode}`,
  });
}

function isRunnerComparisonConsumer(step: WorkflowStep): boolean {
  return typeof step.run === "string" && step.run.includes("tools/e2e/runner-comparison.mts");
}

function publicationIndex(jobSteps: readonly WorkflowStep[]): number {
  return jobSteps.findIndex(
    (step) =>
      step.uses === UPLOAD_E2E_ARTIFACTS_ACTION ||
      step.name === "Scan MCP artifacts for fixture credentials",
  );
}

/**
 * Keep the #7145 comparison to 12 routed workflow lane identities / 13
 * concrete trusted-main job executions. Telemetry is best-effort, but it must
 * span the complete post-prepare job and finish before evidence is scanned or
 * uploaded.
 */
export function validateRunnerComparisonWorkflow(workflowValue: unknown): string[] {
  const jobs = record(record(workflowValue).jobs);
  const errors: string[] = [];

  requireExactMatrixValues(errors, jobs, "channels-stop-start", "agent", ["openclaw", "hermes"]);
  requireExactMatrixValues(errors, jobs, "mcp-bridge", "agent", [
    "openclaw",
    "hermes",
    "deepagents",
  ]);
  requireExactMatrixValues(errors, jobs, "security-posture", "agent", ["openclaw", "hermes"]);
  requireExactMatrixValues(errors, jobs, "hermes-inference-switch", "mode", [
    "hosted",
    "anthropic",
  ]);

  for (const [jobId, value] of Object.entries(jobs)) {
    const jobSteps = steps(record(value).steps);
    const consumers = jobSteps.filter(isRunnerComparisonConsumer);
    if (!COMPARISON_JOBS.has(jobId) && consumers.length > 0) {
      errors.push(`${jobId} must not collect runner comparison telemetry`);
    }
  }

  for (const [jobId, contract] of COMPARISON_JOBS) {
    const jobSteps = steps(record(jobs[jobId]).steps);
    const consumers = jobSteps.filter(isRunnerComparisonConsumer);
    if (consumers.length !== 2) {
      errors.push(`${jobId} must invoke runner comparison telemetry exactly twice`);
      continue;
    }

    const initialize = consumers.find((step) => step.name === RUNNER_COMPARISON_INITIALIZE_STEP);
    const finalize = consumers.find((step) => step.name === RUNNER_COMPARISON_FINALIZE_STEP);
    if (
      !initialize ||
      !exactStep(initialize, RUNNER_COMPARISON_INITIALIZE_STEP, contract.initializeIf, "initialize")
    ) {
      errors.push(`${jobId} must use the exact trusted initialize telemetry step`);
    }
    if (
      !finalize ||
      !exactStep(finalize, RUNNER_COMPARISON_FINALIZE_STEP, contract.finalizeIf, "finalize")
    ) {
      errors.push(`${jobId} must use the exact always-run trusted finalize telemetry step`);
    }
    if (!initialize || !finalize) continue;

    const prepare = jobSteps.findIndex((step) => step.name === PREPARE_E2E_STEP);
    const initializeIndex = jobSteps.indexOf(initialize);
    const finalizeIndex = jobSteps.indexOf(finalize);
    const publish = publicationIndex(jobSteps);
    if (prepare < 0 || initializeIndex !== prepare + 1) {
      errors.push(
        `${jobId} must initialize runner comparison telemetry immediately after prepare-e2e`,
      );
    }
    if (publish < 0 || finalizeIndex !== publish - 1) {
      errors.push(
        `${jobId} must finalize runner comparison telemetry immediately before artifact scanning or upload`,
      );
    }
    if (initializeIndex >= finalizeIndex) {
      errors.push(`${jobId} must initialize runner comparison telemetry before finalizing it`);
    }
  }

  return errors;
}

export function validateRunnerComparisonWorkflowBoundary(workflowValue: unknown): string[] {
  return validateRunnerComparisonWorkflow(workflowValue);
}
