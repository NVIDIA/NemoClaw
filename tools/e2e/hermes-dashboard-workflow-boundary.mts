// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const JOB_NAME = "hermes-dashboard";

// Dashboard recovery has a distinct trust boundary: it alone enables the
// dashboard mode, receives the inference secret at step scope, and must report
// its result before the PR scorecard is published. Keep those invariants in a
// focused validator, matching the repository's other security-posture and
// sandbox-operations workflow-boundary helpers, instead of duplicating them in
// an untyped YAML-shape assertion.

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

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

export function validateHermesDashboardWorkflow(workflow: HermesDashboardWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[JOB_NAME] ?? {};
  const env = job.env ?? {};

  for (const [jobName, candidate] of Object.entries(workflow.jobs)) {
    if (jobName !== JOB_NAME && candidate.env?.NEMOCLAW_E2E_HERMES_DASHBOARD !== undefined) {
      errors.push(
        `only ${JOB_NAME} may enable Hermes dashboard E2E coverage (found on ${jobName})`,
      );
    }
  }

  requireEqual(errors, job.needs, "generate-matrix", `${JOB_NAME} must depend on generate-matrix`);
  requireEqual(errors, job["runs-on"], "ubuntu-latest", `${JOB_NAME} must run on ubuntu-latest`);
  requireEqual(errors, job["timeout-minutes"], 75, `${JOB_NAME} timeout must be 75 minutes`);
  requireEqual(errors, env.E2E_JOB, "1", `${JOB_NAME} must be free-standing`);
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    "hermes-dashboard",
    `${JOB_NAME} must publish the hermes-dashboard selector`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_E2E_HERMES_DASHBOARD,
    "1",
    `${JOB_NAME} must enable Hermes dashboard coverage`,
  );
  requireEqual(errors, env.NEMOCLAW_AGENT, "hermes", `${JOB_NAME} must run Hermes`);
  requireEqual(
    errors,
    env.NEMOCLAW_SANDBOX_NAME,
    "e2e-hermes-dashboard",
    `${JOB_NAME} must use an isolated sandbox`,
  );

  const run = findStep(job, "Run Hermes dashboard live Vitest test");
  if (!run.run?.includes("npx vitest run --project e2e-live")) {
    errors.push(`${JOB_NAME} must run the live Vitest project`);
  }
  if (!run.run?.includes("test/e2e/live/hermes-e2e.test.ts")) {
    errors.push(`${JOB_NAME} must run the Hermes live test`);
  }
  requireEqual(
    errors,
    run.env?.NVIDIA_INFERENCE_API_KEY,
    "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    `${JOB_NAME} must pass the inference key through step env`,
  );

  const reportNeeds = workflow.jobs["report-to-pr"]?.needs;
  if (!Array.isArray(reportNeeds) || !reportNeeds.includes(JOB_NAME)) {
    errors.push(`report-to-pr must wait for ${JOB_NAME}`);
  }

  return errors;
}

export function validateHermesDashboardWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateHermesDashboardWorkflow(readHermesDashboardWorkflow(workflowPath));
}
