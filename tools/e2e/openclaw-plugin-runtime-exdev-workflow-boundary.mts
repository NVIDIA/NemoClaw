// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { PREPARE_E2E_ACTION } from "./prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const JOB_NAME = "openclaw-plugin-runtime-exdev";
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const RELEASE_BUILDER_IMAGE =
  "node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba";

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
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
};

export type OpenClawPluginRuntimeExdevWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readOpenClawPluginRuntimeExdevWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): OpenClawPluginRuntimeExdevWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as OpenClawPluginRuntimeExdevWorkflow;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function requireRunContains(
  errors: string[],
  step: WorkflowStep,
  fragment: string,
  description = step.name ?? "<missing>",
): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${JOB_NAME} step '${description}' must run: ${fragment}`);
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

function requireAdjacentSteps(
  errors: string[],
  steps: WorkflowStep[],
  beforeName: string,
  afterName: string,
): void {
  const before = steps.findIndex((step) => step.name === beforeName);
  const after = steps.findIndex((step) => step.name === afterName);
  if (before < 0 || after !== before + 1) {
    errors.push(`${JOB_NAME} step '${beforeName}' must immediately precede '${afterName}'`);
  }
}

export function validateOpenClawPluginRuntimeExdevWorkflow(
  workflow: OpenClawPluginRuntimeExdevWorkflow,
): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[JOB_NAME];
  if (!job) return [`workflow is missing ${JOB_NAME}`];

  if (job.needs !== "generate-matrix") {
    errors.push(`${JOB_NAME} must depend on generate-matrix`);
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push(`${JOB_NAME} must run on ubuntu-latest`);
  }
  if (job["timeout-minutes"] !== 130) {
    errors.push(`${JOB_NAME} must retain its 130 minute runtime proof budget`);
  }
  if (job.permissions?.contents !== "read" || Object.keys(job.permissions ?? {}).length !== 1) {
    errors.push(`${JOB_NAME} must hold only contents: read`);
  }

  const env = job.env ?? {};
  const expectedEnv = {
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/openclaw-plugin-runtime-exdev",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-openclaw-plugin-exdev",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  for (const [name, value] of Object.entries(expectedEnv)) {
    if (env[name] !== value) errors.push(`${JOB_NAME} must set ${name}=${value}`);
  }
  if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
    errors.push(`${JOB_NAME} must remain enabled for scheduled and empty manual runs`);
  }
  for (const secret of [
    "DOCKERHUB_USERNAME",
    "DOCKERHUB_TOKEN",
    "GITHUB_TOKEN",
    "NVIDIA_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
  ]) {
    if (Object.hasOwn(env, secret))
      errors.push(`${JOB_NAME} must not expose ${secret} at job scope`);
  }

  const steps = job.steps ?? [];
  for (const step of steps.filter((candidate) => candidate.uses)) {
    if (!FULL_SHA_ACTION.test(step.uses ?? "")) {
      errors.push(`${JOB_NAME} action '${step.name ?? step.uses}' must pin a full SHA`);
    }
  }

  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
  if (checkout.with?.["persist-credentials"] !== false) {
    errors.push(`${JOB_NAME} checkout must disable persisted credentials`);
  }

  const prepare = findStep(job, "Prepare E2E workspace");
  if (prepare.uses !== PREPARE_E2E_ACTION) {
    errors.push(`${JOB_NAME} must use the reviewed prepare-e2e action`);
  }

  const prePull = findStep(job, "Pre-pull release-matched Docker Hub builder image");
  requireRunContains(errors, prePull, `docker pull ${RELEASE_BUILDER_IMAGE}`);

  const revoke = findStep(job, "Remove Docker auth before release-pinned fixture");
  if (revoke.if !== "always()") {
    errors.push(`${JOB_NAME} must always revoke Docker auth before the release-pinned fixture`);
  }
  requireRunContains(errors, revoke, "bash .github/scripts/docker-auth-cleanup.sh");

  const runName = "Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV live test";
  const run = findStep(job, runName);
  for (const fragment of [
    'test -n "${DOCKER_CONFIG:-}"',
    'test ! -e "${DOCKER_CONFIG}"',
    'test -z "${DOCKERHUB_USERNAME:-}"',
    'test -z "${DOCKERHUB_TOKEN:-}"',
    "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN",
    "tools/e2e/live-vitest-invocation.mts run --test-path",
    "test/e2e/live/openclaw-plugin-runtime-exdev.test.ts",
  ]) {
    requireRunContains(errors, run, fragment, runName);
  }
  if (Object.keys(run.env ?? {}).length > 0 || JSON.stringify(run).includes("secrets.")) {
    errors.push(`${JOB_NAME} runtime proof must not receive workflow credentials`);
  }

  const upload = findStep(job, "Upload OpenClaw plugin runtime-deps EXDEV artifacts");
  if (upload.uses !== UPLOAD_E2E_ARTIFACTS_ACTION || upload.if !== "always()") {
    errors.push(`${JOB_NAME} must always use the reviewed artifact uploader`);
  }

  requireStepOrder(
    errors,
    steps,
    "Pre-pull release-matched Docker Hub builder image",
    "Remove Docker auth before release-pinned fixture",
  );
  requireStepOrder(
    errors,
    steps,
    "Remove Docker auth before release-pinned fixture",
    "Prepare E2E workspace",
  );
  requireStepOrder(errors, steps, "Prepare E2E workspace", runName);
  requireStepOrder(errors, steps, runName, "Upload OpenClaw plugin runtime-deps EXDEV artifacts");
  requireAdjacentSteps(
    errors,
    steps,
    "Authenticate to Docker Hub",
    "Pre-pull release-matched Docker Hub builder image",
  );
  requireAdjacentSteps(
    errors,
    steps,
    "Pre-pull release-matched Docker Hub builder image",
    "Remove Docker auth before release-pinned fixture",
  );

  return errors;
}

export function validateOpenClawPluginRuntimeExdevWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateOpenClawPluginRuntimeExdevWorkflow(
    readOpenClawPluginRuntimeExdevWorkflow(workflowPath),
  );
}
