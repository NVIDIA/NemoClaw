// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const JOB_NAME = "hermes-gpu-startup";
const RUN_STEP_NAME = "Run Hermes GPU startup live Vitest test";
const DOCKER_AUTH_STEP_NAME = "Authenticate to Docker Hub";
const HOSTED_PROVIDER_ENV_NAMES = [
  "COMPATIBLE_API_KEY",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
] as const;
const SECRET_REFERENCE_PATTERN = /\bsecrets\.[A-Za-z0-9_]+\b/u;
const EXPECTED_SELECTOR =
  "${{ contains(format(',{0},', inputs.jobs), ',hermes-gpu-startup,') || contains(format(',{0},', inputs.targets), ',hermes-gpu-startup,') }}";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
};

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function validateHermesGpuStartupWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf8")));
  const job = asRecord(asRecord(workflow.jobs)[JOB_NAME]);
  const errors: string[] = [];
  if (Object.keys(job).length === 0) {
    return [`workflow missing ${JOB_NAME} job`];
  }

  if (job["runs-on"] !== "linux-amd64-gpu-rtxpro6000-latest-1") {
    errors.push(`${JOB_NAME} job must run on the native RTX PRO 6000 GPU runner`);
  }
  if (job.needs !== "generate-matrix" || job.if !== EXPECTED_SELECTOR) {
    errors.push(`${JOB_NAME} job must remain explicit-only behind generate-matrix`);
  }
  if (job["timeout-minutes"] !== 75) {
    errors.push(`${JOB_NAME} job must keep the 75 minute timeout`);
  }

  const jobEnv = asRecord(job.env);
  const requiredEnv = {
    E2E_DEFAULT_ENABLED: "0",
    E2E_JOB: "1",
    E2E_TARGET_ID: JOB_NAME,
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_SANDBOX_GPU: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-hermes-gpu-startup",
  } as const;
  for (const [name, expected] of Object.entries(requiredEnv)) {
    if (jobEnv[name] !== expected) {
      errors.push(`${JOB_NAME} job must set ${name}=${expected}`);
    }
  }
  if (Object.hasOwn(jobEnv, "NEMOCLAW_DOCKER_GPU_PATCH")) {
    errors.push(
      `${JOB_NAME} job must leave NEMOCLAW_DOCKER_GPU_PATCH unset to exercise auto routing`,
    );
  }
  for (const name of HOSTED_PROVIDER_ENV_NAMES) {
    if (Object.hasOwn(jobEnv, name)) {
      errors.push(`${JOB_NAME} job env must not expose ${name}`);
    }
  }
  if (SECRET_REFERENCE_PATTERN.test(JSON.stringify(jobEnv))) {
    errors.push(`${JOB_NAME} job env must not consume repository secrets`);
  }

  const steps = asSteps(job.steps);
  for (const step of steps) {
    const stepName = step.name ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    for (const name of HOSTED_PROVIDER_ENV_NAMES) {
      if (Object.hasOwn(stepEnv, name)) {
        errors.push(`${JOB_NAME} step '${stepName}' must not expose ${name}`);
      }
    }
    if (stepName !== DOCKER_AUTH_STEP_NAME && SECRET_REFERENCE_PATTERN.test(JSON.stringify(step))) {
      errors.push(`${JOB_NAME} step '${stepName}' must not consume repository secrets`);
    }
    if (stringValue(step.run).includes("test/e2e/live/hermes-e2e.test.ts")) {
      errors.push(`${JOB_NAME} step '${stepName}' must not run the hosted Hermes E2E test`);
    }
  }
  const runStep = steps.find((step) => step.name === RUN_STEP_NAME);
  if (!runStep) {
    errors.push(`${JOB_NAME} job missing step: ${RUN_STEP_NAME}`);
    return errors;
  }
  const runScript = stringValue(runStep.run);
  if (!runScript.includes("npx vitest run --project e2e-live")) {
    errors.push(`${JOB_NAME} step must run the e2e-live Vitest project`);
  }
  if (!runScript.includes("test/e2e/live/hermes-gpu-startup.test.ts")) {
    errors.push(`${JOB_NAME} step must run the dedicated Hermes GPU startup test`);
  }

  return errors;
}
