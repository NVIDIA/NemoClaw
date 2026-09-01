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
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const DOCKER_HUB_CLEANUP_ACTION =
  "NVIDIA/NemoClaw/.github/actions/docker-auth-cleanup@d5f37099766ca82a4516e7d8f0de117cda197fe3";

const JOB_CONTRACTS = [
  {
    jobName: "openclaw-plugin-runtime-exdev",
    timeoutMinutes: 85,
    artifactId: "openclaw-plugin-runtime-exdev",
    sandboxName: "e2e-oc-exdev",
    selector: "current-lifecycle",
    runName: "Run OpenClaw cross-device plugin lifecycle live test",
    uploadName: "Upload OpenClaw cross-device plugin lifecycle artifacts",
    builderImage:
      "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c",
  },
] as const;

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
  jobName: string,
  step: WorkflowStep,
  fragment: string,
  description = step.name ?? "<missing>",
): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${jobName} step '${description}' must run: ${fragment}`);
  }
}

function requireStepOrder(
  errors: string[],
  jobName: string,
  steps: WorkflowStep[],
  beforeName: string,
  afterName: string,
): void {
  const before = steps.findIndex((step) => step.name === beforeName);
  const after = steps.findIndex((step) => step.name === afterName);
  if (before < 0 || after < 0 || before >= after) {
    errors.push(`${jobName} step '${beforeName}' must precede '${afterName}'`);
  }
}

function requireAdjacentSteps(
  errors: string[],
  jobName: string,
  steps: WorkflowStep[],
  beforeName: string,
  afterName: string,
): void {
  const before = steps.findIndex((step) => step.name === beforeName);
  const after = steps.findIndex((step) => step.name === afterName);
  if (before < 0 || after !== before + 1) {
    errors.push(`${jobName} step '${beforeName}' must immediately precede '${afterName}'`);
  }
}

export function validateOpenClawPluginRuntimeExdevWorkflow(
  workflow: OpenClawPluginRuntimeExdevWorkflow,
): string[] {
  const errors: string[] = [];
  for (const contract of JOB_CONTRACTS) {
    const {
      artifactId,
      builderImage,
      jobName,
      runName,
      sandboxName,
      selector,
      timeoutMinutes,
      uploadName,
    } = contract;
    const job = workflow.jobs[jobName];
    if (!job) {
      errors.push(`workflow is missing ${jobName}`);
      continue;
    }

    if (job.needs !== "generate-matrix") errors.push(`${jobName} must depend on generate-matrix`);
    if (job["runs-on"] !== "ubuntu-latest") errors.push(`${jobName} must run on ubuntu-latest`);
    if (job["timeout-minutes"] !== timeoutMinutes) {
      errors.push(`${jobName} must retain its ${timeoutMinutes} minute runtime proof budget`);
    }
    if (job.permissions?.contents !== "read" || Object.keys(job.permissions ?? {}).length !== 1) {
      errors.push(`${jobName} must hold only contents: read`);
    }

    const env = job.env ?? {};
    const expectedEnv = {
      E2E_ARTIFACT_DIR: `\${{ github.workspace }}/e2e-artifacts/live/${artifactId}`,
      E2E_TARGET_ID: artifactId,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_SANDBOX_NAME: sandboxName,
      OPENSHELL_GATEWAY: "nemoclaw",
    };
    for (const [name, value] of Object.entries(expectedEnv)) {
      if (env[name] !== value) errors.push(`${jobName} must set ${name}=${value}`);
    }
    if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
      errors.push(`${jobName} must remain enabled for scheduled and empty manual runs`);
    }
    for (const secret of [
      "DOCKERHUB_USERNAME",
      "DOCKERHUB_TOKEN",
      "GITHUB_TOKEN",
      "NVIDIA_API_KEY",
      "NVIDIA_INFERENCE_API_KEY",
    ]) {
      if (Object.hasOwn(env, secret))
        errors.push(`${jobName} must not expose ${secret} at job scope`);
    }

    const steps = job.steps ?? [];
    for (const step of steps.filter((candidate) => candidate.uses)) {
      if (!FULL_SHA_ACTION.test(step.uses ?? "")) {
        errors.push(`${jobName} action '${step.name ?? step.uses}' must pin a full SHA`);
      }
    }
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
    if (checkout.with?.["persist-credentials"] !== false) {
      errors.push(`${jobName} checkout must disable persisted credentials`);
    }
    const prepare = findStep(job, "Prepare E2E workspace");
    if (prepare.uses !== PREPARE_E2E_ACTION) {
      errors.push(`${jobName} must use the reviewed prepare-e2e action`);
    }

    const prePull = findStep(job, "Pre-pull current-checkout Docker Hub builder image");
    requireRunContains(errors, jobName, prePull, `docker pull ${builderImage}`);
    const revoke = findStep(job, "Remove Docker auth before current-checkout fixture");
    if (revoke.if !== "always()") {
      errors.push(`${jobName} must always revoke Docker auth before the current-checkout fixture`);
    }
    if (
      revoke.uses !== DOCKER_HUB_CLEANUP_ACTION ||
      Object.keys(revoke).sort().join(",") !== "if,name,uses"
    ) {
      errors.push(
        `${jobName} must use the pinned Docker auth cleanup action before artifact restore`,
      );
    }

    const run = findStep(job, runName);
    for (const fragment of [
      'test -n "${DOCKER_CONFIG:-}"',
      'test ! -e "${DOCKER_CONFIG}"',
      'test -z "${DOCKERHUB_USERNAME:-}"',
      'test -z "${DOCKERHUB_TOKEN:-}"',
      "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN",
      "tools/e2e/live-vitest-invocation.mts run",
      "--test-path test/e2e/live/openclaw-plugin-runtime-exdev.test.ts",
      `--selector ${selector}`,
    ]) {
      requireRunContains(errors, jobName, run, fragment, runName);
    }
    if (Object.keys(run.env ?? {}).length > 0 || JSON.stringify(run).includes("secrets.")) {
      errors.push(`${jobName} runtime proof must not receive workflow credentials`);
    }
    const upload = findStep(job, uploadName);
    if (upload.uses !== UPLOAD_E2E_ARTIFACTS_ACTION || upload.if !== "always()") {
      errors.push(`${jobName} must always use the reviewed artifact uploader`);
    }

    requireStepOrder(
      errors,
      jobName,
      steps,
      "Pre-pull current-checkout Docker Hub builder image",
      "Remove Docker auth before current-checkout fixture",
    );
    requireStepOrder(
      errors,
      jobName,
      steps,
      "Remove Docker auth before current-checkout fixture",
      "Prepare E2E workspace",
    );
    requireStepOrder(errors, jobName, steps, "Prepare E2E workspace", runName);
    requireStepOrder(errors, jobName, steps, runName, uploadName);
    requireAdjacentSteps(
      errors,
      jobName,
      steps,
      "Authenticate to Docker Hub",
      "Pre-pull current-checkout Docker Hub builder image",
    );
    requireAdjacentSteps(
      errors,
      jobName,
      steps,
      "Pre-pull current-checkout Docker Hub builder image",
      "Remove Docker auth before current-checkout fixture",
    );
  }

  return errors;
}

export function validateOpenClawPluginRuntimeExdevWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateOpenClawPluginRuntimeExdevWorkflow(
    readOpenClawPluginRuntimeExdevWorkflow(workflowPath),
  );
}
