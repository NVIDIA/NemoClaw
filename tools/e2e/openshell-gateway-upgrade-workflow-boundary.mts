// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const JOB_NAME = "openshell-gateway-upgrade";
const RUN_STEP_NAME = "Run OpenShell gateway upgrade live Vitest test";
const RUN_COMMAND =
  "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-upgrade.test.ts";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { name?: string; run?: string };

const EXPECTED_V055_FIXTURES: WorkflowRecord[] = [
  {
    id: "v0.0.55-x86_64",
    runner: "ubuntu-latest",
    shard: "v0-0-55-x86-64",
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
    nemoclaw_ref: "v0.0.55",
    nemoclaw_commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installer_sha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandbox_base_image_ref:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openshell_version: "0.0.44",
    openclaw_version: "2026.5.22",
  },
];

const EXPECTED_V074_FIXTURE: WorkflowRecord = {
  id: "v0.0.74-x86_64",
  runner: "ubuntu-latest",
  shard: "v0-0-74-x86-64",
  nemoclaw_ref: "v0.0.74",
  nemoclaw_commit: "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
  installer_sha256: "a0cd3feca488d247e53d59d7d8246d2b86e75e95acb5e7d78504b3c0c60fd7db",
  sandbox_base_image_ref:
    "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6",
  openshell_version: "0.0.72",
  openclaw_version: "2026.5.27",
};

const EXPECTED_V089_FIXTURE: WorkflowRecord = {
  id: "v0.0.89-x86_64",
  runner: "ubuntu-latest",
  shard: "v0-0-89-x86-64",
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

function v055Fixtures(job: WorkflowRecord): WorkflowRecord[] {
  const include = record(record(job.strategy).matrix).include;
  return Array.isArray(include)
    ? include.map(record).filter((fixture) => fixture.nemoclaw_ref === "v0.0.55")
    : [];
}

function v074Fixture(job: WorkflowRecord): WorkflowRecord {
  const include = record(record(job.strategy).matrix).include;
  return Array.isArray(include)
    ? (include.map(record).find((fixture) => fixture.nemoclaw_ref === "v0.0.74") ?? {})
    : {};
}

function v089Fixture(job: WorkflowRecord): WorkflowRecord {
  const include = record(record(job.strategy).matrix).include;
  return Array.isArray(include)
    ? (include.map(record).find((fixture) => fixture.nemoclaw_ref === "v0.0.89") ?? {})
    : {};
}

function requireRunContains(errors: string[], step: WorkflowStep, fragment: string): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${JOB_NAME} step '${RUN_STEP_NAME}' must run: ${fragment}`);
  }
}

export function readOpenShellGatewayUpgradeWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): WorkflowRecord {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as WorkflowRecord;
}

export function validateOpenShellGatewayUpgradeWorkflow(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const job = record(record(workflow.jobs)[JOB_NAME]);

  if (job["runs-on"] !== "${{ matrix.runner }}") {
    errors.push(`${JOB_NAME} must run on \${{ matrix.runner }}`);
  }
  if (!isDeepStrictEqual(v055Fixtures(job), EXPECTED_V055_FIXTURES)) {
    errors.push(`${JOB_NAME} v0.0.55 matrix must pin x86_64 and arm64 upgrade fixtures`);
  }
  if (!isDeepStrictEqual(v074Fixture(job), EXPECTED_V074_FIXTURE)) {
    errors.push(`${JOB_NAME} matrix must pin the immediate v0.0.74 x86_64 upgrade fixture`);
  }
  if (!isDeepStrictEqual(v089Fixture(job), EXPECTED_V089_FIXTURE)) {
    errors.push(`${JOB_NAME} matrix must pin the v0.0.89 OpenClaw state-upgrade fixture`);
  }
  const env = record(job.env);
  if (env.NEMOCLAW_E2E_SHARD !== "${{ matrix.shard }}") {
    errors.push(`${JOB_NAME} must publish one risk-signal shard per legacy fixture`);
  }
  if (env.NEMOCLAW_CURRENT_OPENCLAW_VERSION !== "${{ matrix.current_openclaw_version }}") {
    errors.push(`${JOB_NAME} must bind the current OpenClaw version from its fixture`);
  }
  if (env.NEMOCLAW_OPENCLAW_STATE_UPGRADE_PROOF !== "${{ matrix.openclaw_state_upgrade }}") {
    errors.push(`${JOB_NAME} must bind the OpenClaw state-upgrade proof flag from its fixture`);
  }

  const run = jobSteps(job).find((step) => step.name === RUN_STEP_NAME) ?? {};
  requireRunContains(errors, run, RUN_COMMAND);

  return errors;
}

export function validateOpenShellGatewayUpgradeWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateOpenShellGatewayUpgradeWorkflow(readOpenShellGatewayUpgradeWorkflow(workflowPath));
}
