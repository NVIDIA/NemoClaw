// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const CANONICAL_JOB = "hermes-e2e";
const LEGACY_JOB = "hermes-dashboard";
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;

type WorkflowStep = {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string[] | string;
  steps?: WorkflowStep[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
};

export type HermesDashboardWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readHermesDashboardWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): HermesDashboardWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as HermesDashboardWorkflow;
}

function requireEqual(errors: string[], actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) errors.push(message);
}

export function validateHermesDashboardWorkflow(workflow: HermesDashboardWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[CANONICAL_JOB] ?? {};
  const env = job.env ?? {};

  if (workflow.jobs[LEGACY_JOB] !== undefined) {
    errors.push(`${LEGACY_JOB} must remain consolidated into ${CANONICAL_JOB}`);
  }
  for (const [jobName, candidate] of Object.entries(workflow.jobs)) {
    if (jobName !== CANONICAL_JOB && candidate.env?.NEMOCLAW_E2E_HERMES_DASHBOARD !== undefined) {
      errors.push(
        `only ${CANONICAL_JOB} may enable Hermes dashboard E2E coverage (found on ${jobName})`,
      );
    }
  }

  requireEqual(
    errors,
    env.NEMOCLAW_E2E_HERMES_DASHBOARD,
    "1",
    `${CANONICAL_JOB} must enable Hermes dashboard coverage`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_E2E_INFERENCE_MODE,
    "${{ inputs.inference_mode || 'mock' }}",
    `${CANONICAL_JOB} must preserve manual inference-mode selection`,
  );
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    CANONICAL_JOB,
    `${CANONICAL_JOB} must publish its canonical selector`,
  );

  const steps = job.steps ?? [];
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
  if (!FULL_SHA_ACTION.test(checkout.uses ?? "")) {
    errors.push(`${CANONICAL_JOB} checkout must pin a full action SHA`);
  }
  if (checkout.with?.["persist-credentials"] !== false) {
    errors.push(`${CANONICAL_JOB} checkout must disable persisted credentials`);
  }
  const run = steps.find((step) => step.name === "Run Hermes live Vitest test") ?? {};
  if (!run.run?.includes("tools/e2e/live-vitest-invocation.mts run --test-path")) {
    errors.push(`${CANONICAL_JOB} must run the live Vitest project`);
  }
  if (!run.run?.includes("test/e2e/live/hermes-e2e.test.ts")) {
    errors.push(`${CANONICAL_JOB} must run the Hermes live test`);
  }

  const reportNeeds = workflow.jobs["report-to-pr"]?.needs;
  if (!Array.isArray(reportNeeds) || !reportNeeds.includes(CANONICAL_JOB)) {
    errors.push(`report-to-pr must wait for ${CANONICAL_JOB}`);
  }
  if (Array.isArray(reportNeeds) && reportNeeds.includes(LEGACY_JOB)) {
    errors.push(`report-to-pr must not wait for retired ${LEGACY_JOB}`);
  }

  return errors;
}

export function validateHermesDashboardWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateHermesDashboardWorkflow(readHermesDashboardWorkflow(workflowPath));
}
