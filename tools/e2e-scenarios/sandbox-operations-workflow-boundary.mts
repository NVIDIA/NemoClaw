// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { validateE2eVitestScenariosWorkflowBoundary } from "./workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-vitest-scenarios.yaml");
const JOB_NAME = "sandbox-operations-vitest";
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

export type SandboxOperationsWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readSandboxOperationsWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): SandboxOperationsWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as SandboxOperationsWorkflow;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function requireRunContains(errors: string[], step: WorkflowStep, fragment: string): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${JOB_NAME} step '${step.name ?? "<missing>"}' must run: ${fragment}`);
  }
}

function requireStepOrder(
  errors: string[],
  steps: WorkflowStep[],
  beforeName: string,
  afterName: string,
): void {
  const before = steps.findIndex((step) => step.name === beforeName);
  const after = steps.findIndex((step) => step.name === afterName);
  if (before < 0 || after < 0 || before >= after) {
    errors.push(`${JOB_NAME} step '${beforeName}' must precede '${afterName}'`);
  }
}

export function validateSandboxOperationsWorkflow(workflow: SandboxOperationsWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[JOB_NAME] ?? {};
  const jobEnv = job.env ?? {};
  const steps = job.steps ?? [];

  if (Object.hasOwn(jobEnv, "DOCKER_CONFIG")) {
    errors.push(`${JOB_NAME} must not configure Docker auth at job scope`);
  }

  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
  if (!FULL_SHA_ACTION.test(checkout.uses ?? "")) {
    errors.push(`${JOB_NAME} checkout must pin a full action SHA`);
  }
  if (checkout.with?.["persist-credentials"] !== false) {
    errors.push(`${JOB_NAME} checkout must disable persisted credentials`);
  }
  for (const step of steps.filter((entry) => entry.uses)) {
    if (!FULL_SHA_ACTION.test(step.uses ?? "")) {
      errors.push(`${JOB_NAME} action '${step.name ?? step.uses}' must pin a full SHA`);
    }
  }

  const install = findStep(job, "Install OpenShell CLI");
  for (const variable of [
    "DOCKER_CONFIG",
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "NVIDIA_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
    "GITHUB_TOKEN",
  ]) {
    requireRunContains(errors, install, `-u ${variable}`);
  }
  requireRunContains(errors, install, "bash scripts/install-openshell.sh");

  const configure = findStep(job, "Configure isolated Docker auth directory");
  requireRunContains(
    errors,
    configure,
    "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-sandbox-operations",
  );
  requireRunContains(errors, configure, '>> "$GITHUB_ENV"');

  const authenticate = findStep(job, "Authenticate to Docker Hub");
  if (authenticate.env?.DOCKERHUB_USERNAME !== "${{ secrets.DOCKERHUB_USERNAME }}") {
    errors.push(`${JOB_NAME} Docker username must be scoped to the auth step`);
  }
  if (authenticate.env?.DOCKERHUB_TOKEN !== "${{ secrets.DOCKERHUB_TOKEN }}") {
    errors.push(`${JOB_NAME} Docker token must be scoped to the auth step`);
  }

  requireStepOrder(errors, steps, "Install OpenShell CLI", configure.name ?? "");
  requireStepOrder(errors, steps, configure.name ?? "", authenticate.name ?? "");
  requireStepOrder(errors, steps, authenticate.name ?? "", "Run sandbox operations live test");

  const run = findStep(job, "Run sandbox operations live test");
  if (run.env?.NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(`${JOB_NAME} inference key must be scoped to the live test step`);
  }
  for (const step of steps.filter((entry) => entry !== run)) {
    if (step.env?.NVIDIA_INFERENCE_API_KEY !== undefined) {
      errors.push(`${JOB_NAME} exposes the inference key outside the live test step`);
    }
  }
  requireRunContains(errors, run, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, run, "test/e2e-scenario/live/sandbox-operations.test.ts");

  const upload = findStep(job, "Upload sandbox operations artifacts");
  if (upload.if !== "always()") errors.push(`${JOB_NAME} artifact upload must always run`);
  if (upload.with?.path !== "e2e-artifacts/vitest/sandbox-operations/") {
    errors.push(`${JOB_NAME} must upload sandbox operations artifacts`);
  }
  if (upload.with?.["include-hidden-files"] !== false) {
    errors.push(`${JOB_NAME} artifact upload must exclude hidden files`);
  }

  const cleanup = findStep(job, "Clean up Docker auth");
  if (cleanup.if !== "always()") errors.push(`${JOB_NAME} Docker auth cleanup must always run`);
  requireRunContains(errors, cleanup, "docker logout docker.io");
  requireRunContains(errors, cleanup, 'rm -rf "${DOCKER_CONFIG}"');

  return errors;
}

export function validateSandboxOperationsWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return [
    ...validateE2eVitestScenariosWorkflowBoundary(workflowPath),
    ...validateSandboxOperationsWorkflow(readSandboxOperationsWorkflow(workflowPath)),
  ];
}
