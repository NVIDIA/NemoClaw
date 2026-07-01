// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { PREPARE_E2E_ACTION, PREPARE_E2E_STEP } from "./prepare-e2e-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const JOB_NAME = "docs-validation";

type WorkflowStep = {
  if?: string;
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

export type DocsValidationWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readDocsValidationWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): DocsValidationWorkflow {
  const parsed: unknown = YAML.parse(readFileSync(workflowPath, "utf8"));
  const jobs =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { jobs?: unknown }).jobs
      : undefined;
  return {
    jobs:
      jobs && typeof jobs === "object" && !Array.isArray(jobs)
        ? (jobs as Record<string, WorkflowJob>)
        : {},
  };
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function requireEqual(errors: string[], actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) errors.push(message);
}

function requireRunContains(errors: string[], step: WorkflowStep, fragment: string): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${JOB_NAME} step ${step.name ?? "<missing>"} must contain: ${fragment}`);
  }
}

export function validateDocsValidationWorkflow(workflow: DocsValidationWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[JOB_NAME] ?? {};
  const env = job.env ?? {};

  requireEqual(errors, job.needs, "generate-matrix", `${JOB_NAME} must depend on generate-matrix`);
  requireEqual(
    errors,
    job.if,
    "${{ (github.event_name != 'workflow_dispatch' || (inputs.jobs == '' && inputs.targets == '')) || contains(format(',{0},', inputs.jobs), ',docs-validation,') || contains(format(',{0},', inputs.targets), ',docs-validation,') }}",
    `${JOB_NAME} must remain default-enabled and selectively dispatchable`,
  );
  requireEqual(errors, job["runs-on"], "ubuntu-latest", `${JOB_NAME} must run on ubuntu-latest`);
  requireEqual(errors, job["timeout-minutes"], 15, `${JOB_NAME} timeout must remain 15 minutes`);
  requireEqual(errors, env.E2E_JOB, "1", `${JOB_NAME} must be free-standing`);
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    "docs-validation",
    `${JOB_NAME} must publish the docs-validation selector`,
  );
  requireEqual(
    errors,
    env.CHECK_DOC_LINKS_REMOTE,
    "0",
    `${JOB_NAME} must keep link checks deterministic and local-only`,
  );
  requireEqual(
    errors,
    env.E2E_ARTIFACT_DIR,
    "${{ github.workspace }}/e2e-artifacts/live/docs-validation",
    `${JOB_NAME} must isolate docs-validation artifacts`,
  );
  requireEqual(errors, env.NEMOCLAW_RUN_LIVE_E2E, "1", `${JOB_NAME} must enable live E2E`);

  const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (!checkout || !/^actions\/checkout@[0-9a-f]{40}$/u.test(checkout.uses ?? "")) {
    errors.push(`${JOB_NAME} checkout must pin a full action SHA`);
  }
  if (checkout?.with?.["persist-credentials"] !== false) {
    errors.push(`${JOB_NAME} checkout must disable persisted credentials`);
  }

  const prepare = findStep(job, PREPARE_E2E_STEP);
  requireEqual(errors, prepare.uses, PREPARE_E2E_ACTION, `${JOB_NAME} must use prepare-e2e`);
  requireEqual(errors, prepare.with?.["build-cli"], "false", `${JOB_NAME} must skip the CLI build`);

  const run = findStep(job, "Run docs validation live Vitest test");
  requireRunContains(errors, run, "npx vitest run --project e2e-live");
  requireRunContains(errors, run, "test/e2e/live/docs-validation.test.ts");

  const reportNeeds = workflow.jobs["report-to-pr"]?.needs;
  if (!Array.isArray(reportNeeds) || !reportNeeds.includes(JOB_NAME)) {
    errors.push(`report-to-pr must wait for ${JOB_NAME}`);
  }

  return errors;
}

export function validateDocsValidationWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateDocsValidationWorkflow(readDocsValidationWorkflow(workflowPath));
}
