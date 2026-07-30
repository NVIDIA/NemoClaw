// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const NIGHTLY_JOB_NAME = "openshell-gateway-upgrade";
const COMPATIBILITY_JOB_NAME = "openshell-gateway-upgrade-compatibility";
const NIGHTLY_CRON = "0 0 * * 1-6";
const WEEKLY_CRON = "0 0 * * 0";
const RUN_STEP_NAME = "Run OpenShell gateway upgrade live Vitest test";
const RUN_COMMAND =
  "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-upgrade.test.ts";
const COMPATIBILITY_JOB_DISPLAY_NAME =
  "openshell-gateway-upgrade-compatibility / ${{ matrix.id }}";
const NIGHTLY_CONDITION =
  "${{ (github.event_name != 'workflow_dispatch' || (inputs.jobs == '' && inputs.targets == '')) || contains(format(',{0},', inputs.jobs), ',openshell-gateway-upgrade,') || contains(format(',{0},', inputs.targets), ',openshell-gateway-upgrade,') }}";
const COMPATIBILITY_CONDITION =
  "${{ (github.event_name == 'schedule' && github.event.schedule == '0 0 * * 0') || contains(format(',{0},', inputs.jobs), ',openshell-gateway-upgrade-compatibility,') || contains(format(',{0},', inputs.targets), ',openshell-gateway-upgrade-compatibility,') }}";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { name?: string; run?: string };

const V036_FIXTURE: WorkflowRecord = {
  id: "v0.0.36-x86_64",
  runner: "ubuntu-latest",
  shard: "v0-0-36-x86-64",
  tier: "weekly",
  boundary: "oldest retained registry migration",
  nemoclaw_ref: "v0.0.36",
  nemoclaw_commit: "3351fbdd4eb7d9b80ec471545083956327da2b10",
  installer_sha256: "0c42400a0d3867739f1d75d612e069967be4506e169974bbbebf14b7af39144f",
  sandbox_base_image_ref:
    "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
  openshell_version: "0.0.36",
  openclaw_version: "2026.4.24",
};

const V055_FIXTURES: WorkflowRecord[] = [
  {
    id: "v0.0.55-x86_64",
    runner: "ubuntu-latest",
    shard: "v0-0-55-x86-64",
    tier: "weekly",
    boundary: "x86_64 OpenShell 0.0.44 regression",
    nemoclaw_ref: "v0.0.55",
    nemoclaw_commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installer_sha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandbox_base_image_ref:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openshell_version: "0.0.44",
    openclaw_version: "2026.5.22",
  },
  {
    id: "v0.0.55-aarch64",
    runner: "ubuntu-24.04-arm",
    shard: "v0-0-55-aarch64",
    tier: "weekly",
    boundary: "arm64 OpenShell 0.0.44 regression",
    nemoclaw_ref: "v0.0.55",
    nemoclaw_commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installer_sha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandbox_base_image_ref:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openshell_version: "0.0.44",
    openclaw_version: "2026.5.22",
  },
];

const V074_FIXTURE: WorkflowRecord = {
  id: "v0.0.74-x86_64",
  runner: "ubuntu-latest",
  shard: "v0-0-74-x86-64",
  tier: "weekly",
  boundary: "immediate predecessor registry migration",
  nemoclaw_ref: "v0.0.74",
  nemoclaw_commit: "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
  installer_sha256: "a0cd3feca488d247e53d59d7d8246d2b86e75e95acb5e7d78504b3c0c60fd7db",
  sandbox_base_image_ref:
    "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
  openshell_version: "0.0.72",
  openclaw_version: "2026.5.27",
};

const V089_FIXTURE: WorkflowRecord = {
  id: "v0.0.89-x86_64",
  runner: "ubuntu-latest",
  shard: "v0-0-89-x86-64",
  tier: "nightly",
  boundary: "current OpenClaw state migration",
  nemoclaw_ref: "v0.0.89",
  nemoclaw_commit: "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
  installer_sha256: "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2",
  sandbox_base_image_ref:
    "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1",
  openshell_version: "0.0.85",
  openclaw_version: "2026.6.10",
  current_openclaw_version: "2026.7.1",
  openclaw_state_upgrade: "1",
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function jobSteps(job: WorkflowRecord): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

function matrixFixtures(job: WorkflowRecord): WorkflowRecord[] {
  const include = record(record(job.strategy).matrix).include;
  return Array.isArray(include) ? include.map(record) : [];
}

function requireRunContains(
  errors: string[],
  jobName: string,
  step: WorkflowStep,
  fragment: string,
): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${jobName} step '${RUN_STEP_NAME}' must run: ${fragment}`);
  }
}

function validateJob(
  errors: string[],
  jobName: string,
  job: WorkflowRecord,
  fixtures: WorkflowRecord[],
  condition: string,
  explicitOnly: boolean,
): void {
  if (job.if !== condition) {
    errors.push(`${jobName} must retain its execution-tier selector`);
  }
  if (jobName === COMPATIBILITY_JOB_NAME && job.name !== COMPATIBILITY_JOB_DISPLAY_NAME) {
    errors.push(`${jobName} must keep one scorecard identity across its matrix`);
  }
  if (job["runs-on"] !== "${{ matrix.runner }}") {
    errors.push(`${jobName} must run on \${{ matrix.runner }}`);
  }
  if (!isDeepStrictEqual(matrixFixtures(job), fixtures)) {
    errors.push(`${jobName} matrix must pin its tiered gateway upgrade fixtures`);
  }
  const env = record(job.env);
  if (env.E2E_TARGET_ID !== jobName) {
    errors.push(`${jobName} must publish its own target identity`);
  }
  if (explicitOnly ? env.E2E_DEFAULT_ENABLED !== "0" : Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
    errors.push(
      explicitOnly
        ? `${jobName} must remain explicit-only outside the weekly schedule`
        : `${jobName} must remain default-enabled`,
    );
  }
  if (env.NEMOCLAW_E2E_SHARD !== "${{ matrix.shard }}") {
    errors.push(`${jobName} must publish one risk-signal shard per legacy fixture`);
  }
  if (env.NEMOCLAW_CURRENT_OPENCLAW_VERSION !== "${{ matrix.current_openclaw_version }}") {
    errors.push(`${jobName} must bind the current OpenClaw version from its fixture`);
  }
  if (env.NEMOCLAW_OPENCLAW_STATE_UPGRADE_PROOF !== "${{ matrix.openclaw_state_upgrade }}") {
    errors.push(`${jobName} must bind the OpenClaw state-upgrade proof flag from its fixture`);
  }
  const run = jobSteps(job).find((step) => step.name === RUN_STEP_NAME) ?? {};
  requireRunContains(errors, jobName, run, RUN_COMMAND);
}

export function readOpenShellGatewayUpgradeWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): WorkflowRecord {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as WorkflowRecord;
}

export function validateOpenShellGatewayUpgradeWorkflow(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const jobs = record(workflow.jobs);
  const triggers = record(workflow.on ?? workflow[true as unknown as string]);
  const schedules = triggers.schedule;
  if (
    !isDeepStrictEqual(schedules, [{ cron: NIGHTLY_CRON }, { cron: WEEKLY_CRON }])
  ) {
    errors.push("E2E schedule must separate six nightly runs from the weekly compatibility run");
  }

  validateJob(
    errors,
    NIGHTLY_JOB_NAME,
    record(jobs[NIGHTLY_JOB_NAME]),
    [V089_FIXTURE],
    NIGHTLY_CONDITION,
    false,
  );
  validateJob(
    errors,
    COMPATIBILITY_JOB_NAME,
    record(jobs[COMPATIBILITY_JOB_NAME]),
    [V036_FIXTURE, ...V055_FIXTURES, V074_FIXTURE],
    COMPATIBILITY_CONDITION,
    true,
  );
  return errors;
}

export function validateOpenShellGatewayUpgradeWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateOpenShellGatewayUpgradeWorkflow(readOpenShellGatewayUpgradeWorkflow(workflowPath));
}
