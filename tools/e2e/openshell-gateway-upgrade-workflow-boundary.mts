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
    nemoclaw_ref: "v0.0.55",
    nemoclaw_commit: "95d483fe2b6569d68e59493c60f19df09a068e8f",
    installer_sha256: "ff8cf448e4d17b00421545a1f333262b615b1b0aa236d0cc5aeaf4e2cae2d897",
    sandbox_base_image_ref:
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:10433a8cd2f2b809dd0fdf983514679e04c0f8aa1ff5bbff675029046033b108",
    openshell_version: "0.0.44",
    openclaw_version: "2026.5.22",
  },
];

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function jobSteps(job: WorkflowRecord): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

function v055Fixtures(job: WorkflowRecord): WorkflowRecord[] {
  const legacy = record(record(job.strategy).matrix).legacy;
  return Array.isArray(legacy)
    ? legacy.map(record).filter((fixture) => fixture.nemoclaw_ref === "v0.0.55")
    : [];
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

  if (job["runs-on"] !== "${{ matrix.legacy.runner }}") {
    errors.push(`${JOB_NAME} must run on \${{ matrix.legacy.runner }}`);
  }
  if (!isDeepStrictEqual(v055Fixtures(job), EXPECTED_V055_FIXTURES)) {
    errors.push(`${JOB_NAME} v0.0.55 matrix must pin x86_64 and arm64 upgrade fixtures`);
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
