// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { CLI_ARTIFACT_RESTORE_STEP } from "./cli-artifact-workflow-boundary.mts";
import { PREPARE_E2E_STEP } from "./prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

export const RUNNER_COMPARISON_INITIALIZE_STEP = "Initialize runner comparison telemetry";
export const RUNNER_COMPARISON_FINALIZE_STEP = "Finalize runner comparison telemetry";
export const RUNNER_COMPARISON_COMMAND = "npx tsx tools/e2e/runner-comparison.mts";

const TRUSTED_MAIN_GUARD =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha == ''";
const MCP_AGENT_GUARD = "(matrix.agent == 'hermes' || matrix.agent == 'deepagents')";
const ORDINARY_INITIALIZE_GUARD = `\${{ ${TRUSTED_MAIN_GUARD} }}`;
const ORDINARY_FINALIZE_GUARD = `\${{ always() && ${TRUSTED_MAIN_GUARD} }}`;
const MCP_INITIALIZE_GUARD = `\${{ ${TRUSTED_MAIN_GUARD} && ${MCP_AGENT_GUARD} }}`;
const MCP_FINALIZE_GUARD = `\${{ always() && ${TRUSTED_MAIN_GUARD} && ${MCP_AGENT_GUARD} }}`;

const COMPARISON_JOBS: ReadonlyMap<string, { initializeIf: string; finalizeIf: string }> = new Map([
  [
    "common-egress-agent",
    { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD },
  ],
  ["hermes-e2e", { initializeIf: ORDINARY_INITIALIZE_GUARD, finalizeIf: ORDINARY_FINALIZE_GUARD }],
  ["mcp-bridge", { initializeIf: MCP_INITIALIZE_GUARD, finalizeIf: MCP_FINALIZE_GUARD }],
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
 * Keep runner diagnostics on the three retained routed workflow jobs.
 * Telemetry is best-effort, but it must span the
 * complete stable-capacity job and finish before evidence is scanned or
 * uploaded. Rebuild jobs establish their fixed swap capacity first because the
 * v2 ledger rejects capacity changes after initialization.
 */
export function validateRunnerComparisonWorkflow(workflowValue: unknown): string[] {
  const jobs = record(record(workflowValue).jobs);
  const errors: string[] = [];

  requireExactMatrixValues(errors, jobs, "common-egress-agent", "scenario", [
    "openclaw-balanced-weather",
    "openclaw-open-reference",
    "hermes-open-reference",
  ]);
  requireExactMatrixValues(errors, jobs, "mcp-bridge", "agent", [
    "openclaw",
    "hermes",
    "deepagents",
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
    const restore = jobSteps.findIndex((step) => step.name === CLI_ARTIFACT_RESTORE_STEP);
    const bootstrapEnd = restore >= 0 ? restore : prepare;
    const initializationBoundary = restore >= 0 ? "CLI artifact restore" : "workspace preparation";
    const initializeIndex = jobSteps.indexOf(initialize);
    const finalizeIndex = jobSteps.indexOf(finalize);
    const publish = publicationIndex(jobSteps);
    if (prepare < 0 || bootstrapEnd < prepare || initializeIndex !== bootstrapEnd + 1) {
      errors.push(
        `${jobId} must initialize runner comparison telemetry immediately after ${initializationBoundary}`,
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
