// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-vitest-scenarios.yaml");
const JOB_NAME = "security-posture-vitest";
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(job: WorkflowRecord): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

function namedStep(jobSteps: WorkflowStep[], name: string): WorkflowStep {
  return jobSteps.find((step) => step.name === name) ?? {};
}

function requireRunContains(errors: string[], step: WorkflowStep, fragment: string): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${JOB_NAME} step '${step.name ?? "<missing>"}' must run: ${fragment}`);
  }
}

function normalizedMatrixInclude(job: WorkflowRecord): WorkflowRecord[] {
  const include = record(record(job.strategy).matrix).include;
  return Array.isArray(include) ? include.map(record) : [];
}

export function readSecurityPostureWorkflow(workflowPath = DEFAULT_WORKFLOW_PATH): WorkflowRecord {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as WorkflowRecord;
}

export function validateSecurityPostureWorkflow(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const job = record(record(workflow.jobs)[JOB_NAME]);
  const jobEnv = record(job.env);
  const jobSteps = steps(job);

  if (job.needs !== "generate-matrix") {
    errors.push(`${JOB_NAME} must depend on generate-matrix`);
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    errors.push(`${JOB_NAME} must run on ubuntu-latest`);
  }
  if (job["timeout-minutes"] !== 75) {
    errors.push(`${JOB_NAME} must retain its 75 minute two-agent budget`);
  }
  const permissions = record(job.permissions);
  if (permissions.contents !== "read" || Object.keys(permissions).length !== 1) {
    errors.push(`${JOB_NAME} must hold only contents: read`);
  }
  if (record(job.strategy)["fail-fast"] !== false) {
    errors.push(`${JOB_NAME} matrix must keep fail-fast disabled`);
  }

  const expectedMatrix = [
    {
      agent: "openclaw",
      sandbox_name: "e2e-openclaw-security-posture",
      test_file: "test/e2e-scenario/live/full-e2e.test.ts",
    },
    {
      agent: "hermes",
      sandbox_name: "e2e-hermes-security-posture",
      test_file: "test/e2e-scenario/live/hermes-e2e.test.ts",
    },
  ];
  if (JSON.stringify(normalizedMatrixInclude(job)) !== JSON.stringify(expectedMatrix)) {
    errors.push(`${JOB_NAME} matrix must cover the OpenClaw and Hermes security-posture modes`);
  }

  const expectedEnv: WorkflowRecord = {
    E2E_ARTIFACT_DIR:
      "${{ github.workspace }}/e2e-artifacts/vitest/security-posture-${{ matrix.agent }}",
    FREE_STANDING_VITEST_JOB: "1",
    FREE_STANDING_SCENARIO_ID: "security-posture",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "${{ matrix.agent }}",
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
    NEMOCLAW_E2E_SECURITY_POSTURE: "1",
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: "60",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_RUN_E2E_SCENARIOS: "1",
    NEMOCLAW_SANDBOX_NAME: "${{ matrix.sandbox_name }}",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  for (const [name, value] of Object.entries(expectedEnv)) {
    if (jobEnv[name] !== value) errors.push(`${JOB_NAME} must set ${name}=${value}`);
  }
  if (Object.hasOwn(jobEnv, "NVIDIA_INFERENCE_API_KEY")) {
    errors.push(`${JOB_NAME} must not expose the inference key at job scope`);
  }

  const checkout = jobSteps.find((step) => step.uses?.startsWith("actions/checkout@")) ?? {};
  if (!FULL_SHA_ACTION.test(checkout.uses ?? "")) {
    errors.push(`${JOB_NAME} checkout must pin a full action SHA`);
  }
  if (record(checkout.with)["persist-credentials"] !== false) {
    errors.push(`${JOB_NAME} checkout must disable persisted credentials`);
  }
  for (const step of jobSteps.filter((entry) => entry.uses)) {
    if (!FULL_SHA_ACTION.test(step.uses ?? "")) {
      errors.push(`${JOB_NAME} action '${step.name ?? step.uses}' must pin a full SHA`);
    }
  }

  const install = namedStep(jobSteps, "Install OpenShell CLI");
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

  const run = namedStep(jobSteps, "Run security posture live Vitest test");
  if (record(run.env).NVIDIA_INFERENCE_API_KEY !== "${{ secrets.NVIDIA_INFERENCE_API_KEY }}") {
    errors.push(`${JOB_NAME} inference key must be scoped to the live test step`);
  }
  for (const step of jobSteps.filter((entry) => entry !== run)) {
    if (record(step.env).NVIDIA_INFERENCE_API_KEY !== undefined) {
      errors.push(`${JOB_NAME} exposes the inference key outside the live test step`);
    }
  }
  requireRunContains(errors, run, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, run, '"${{ matrix.test_file }}"');

  const upload = namedStep(jobSteps, "Upload security posture artifacts");
  if (upload.if !== "always()") errors.push(`${JOB_NAME} artifact upload must always run`);
  if (record(upload.with).name !== "e2e-vitest-scenarios-security-posture-${{ matrix.agent }}") {
    errors.push(`${JOB_NAME} artifact name must identify the agent matrix leg`);
  }
  if (record(upload.with).path !== "e2e-artifacts/vitest/security-posture-${{ matrix.agent }}/") {
    errors.push(`${JOB_NAME} artifact path must identify the agent matrix leg`);
  }
  if (record(upload.with)["include-hidden-files"] !== false) {
    errors.push(`${JOB_NAME} artifact upload must exclude hidden files`);
  }
  if (record(upload.with)["if-no-files-found"] !== "ignore") {
    errors.push(`${JOB_NAME} artifact upload must ignore missing files`);
  }
  if (record(upload.with)["retention-days"] !== 14) {
    errors.push(`${JOB_NAME} artifact retention must be 14 days`);
  }

  return errors;
}
