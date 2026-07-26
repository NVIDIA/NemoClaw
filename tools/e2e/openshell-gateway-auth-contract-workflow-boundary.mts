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
const JOB_NAME = "openshell-gateway-auth-contract";
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const EXPLICIT_ONLY_CONDITION =
  "${{ contains(format(',{0},', inputs.jobs), ',openshell-gateway-auth-contract,') || contains(format(',{0},', inputs.targets), ',openshell-gateway-auth-contract,') }}";
const GATEWAY_PROBE_IMAGE =
  "node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba";
const ARTIFACT_SAFETY_GATED_UPLOAD =
  "${{ always() && steps.artifact_safety.outcome == 'success' && steps.artifact_safety.outputs.approved_path != '' }}";
const APPROVED_ARTIFACT_PATH = "${{ steps.artifact_safety.outputs.approved_path }}";
const ARTIFACT_SAFETY_COMMAND =
  'node --experimental-strip-types --no-warnings tools/e2e/openshell-gateway-auth-artifact-safety.mts "$E2E_ARTIFACT_DIR"';

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
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
  steps?: WorkflowStep[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
};

export type OpenShellGatewayAuthContractWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export function readOpenShellGatewayAuthContractWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): OpenShellGatewayAuthContractWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as OpenShellGatewayAuthContractWorkflow;
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

export function validateOpenShellGatewayAuthContractWorkflow(
  workflow: OpenShellGatewayAuthContractWorkflow,
): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[JOB_NAME];
  if (!job) return [`workflow is missing ${JOB_NAME}`];

  if (job.needs !== "generate-matrix") {
    errors.push(`${JOB_NAME} must depend on generate-matrix`);
  }
  if (job.if !== EXPLICIT_ONLY_CONDITION) {
    errors.push(`${JOB_NAME} must run only when explicitly selected`);
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push(`${JOB_NAME} must run on ubuntu-latest`);
  }
  if (job["timeout-minutes"] !== 20) {
    errors.push(`${JOB_NAME} must retain its 20 minute resource budget`);
  }

  const env = job.env ?? {};
  const expectedEnv = {
    DOCKER_GRPC_PROBE_IMAGE: GATEWAY_PROBE_IMAGE,
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/openshell-gateway-auth-contract",
    E2E_DEFAULT_ENABLED: "0",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RUN_LIVE_E2E: "1",
  };
  for (const [name, value] of Object.entries(expectedEnv)) {
    if (env[name] !== value) errors.push(`${JOB_NAME} must set ${name}=${value}`);
  }
  const pinVersion = env.NEMOCLAW_OPENSHELL_PIN_VERSION;
  if (typeof pinVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(pinVersion)) {
    errors.push(`${JOB_NAME} must set NEMOCLAW_OPENSHELL_PIN_VERSION to an exact version`);
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

  const prePull = findStep(job, "Pre-pull pinned gateway auth probe image");
  requireRunContains(errors, prePull, 'docker pull "$DOCKER_GRPC_PROBE_IMAGE"');

  const runName = "Run OpenShell gateway auth contract live test";
  const run = findStep(job, runName);
  requireRunContains(errors, run, "tools/e2e/live-vitest-invocation.mts run --test-path");
  requireRunContains(errors, run, "test/e2e/live/openshell-gateway-auth-source-contract.test.ts");
  if (Object.keys(run.env ?? {}).length > 0 || JSON.stringify(run).includes("secrets.")) {
    errors.push(`${JOB_NAME} live test must not receive workflow credentials`);
  }

  const artifactSafetyName = "Validate final OpenShell gateway auth contract artifacts";
  const artifactSafety = findStep(job, artifactSafetyName);
  if (artifactSafety.id !== "artifact_safety" || artifactSafety.if !== "always()") {
    errors.push(`${JOB_NAME} final artifact safety scan must run unconditionally with a stable id`);
  }
  if (artifactSafety.run?.trim() !== ARTIFACT_SAFETY_COMMAND) {
    errors.push(
      `${JOB_NAME} step '${artifactSafety.name ?? "<missing>"}' must run exactly: ${ARTIFACT_SAFETY_COMMAND}`,
    );
  }

  const upload = findStep(job, "Upload OpenShell gateway auth contract artifacts");
  if (upload.uses !== UPLOAD_E2E_ARTIFACTS_ACTION) {
    errors.push(`${JOB_NAME} must use the reviewed artifact uploader`);
  }
  if (upload.if !== ARTIFACT_SAFETY_GATED_UPLOAD) {
    errors.push(`${JOB_NAME} must upload artifacts only after this run attempt passes safety scan`);
  }
  if (upload.with?.path !== APPROVED_ARTIFACT_PATH) {
    errors.push(`${JOB_NAME} must upload only the immutable approved artifact payload`);
  }

  requireStepOrder(errors, steps, "Prepare E2E workspace", "Install OpenShell CLI");
  requireStepOrder(
    errors,
    steps,
    "Install OpenShell CLI",
    "Pre-pull pinned gateway auth probe image",
  );
  requireStepOrder(errors, steps, "Pre-pull pinned gateway auth probe image", runName);
  requireStepOrder(errors, steps, runName, artifactSafetyName);
  requireStepOrder(
    errors,
    steps,
    artifactSafetyName,
    "Upload OpenShell gateway auth contract artifacts",
  );
  requireStepOrder(errors, steps, runName, "Upload OpenShell gateway auth contract artifacts");

  return errors;
}

export function validateOpenShellGatewayAuthContractWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateOpenShellGatewayAuthContractWorkflow(
    readOpenShellGatewayAuthContractWorkflow(workflowPath),
  );
}
