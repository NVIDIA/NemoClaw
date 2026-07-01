// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ACTION_PATH = join(REPO_ROOT, ".github", "actions", "prepare-e2e", "action.yaml");

const PREPARE_E2E_ACTION_PROVENANCE = {
  reference: "NVIDIA/NemoClaw/.github/actions/prepare-e2e@50281ee84c4a6fc759da95ea28fc0b7d9c378a28",
  contentSha256: "eca1994acd70f4305cddae2990d1604e9fac455b45d3d89dfb4b08a07d7552a1",
} as const;

export const PREPARE_E2E_ACTION = PREPARE_E2E_ACTION_PROVENANCE.reference;
export const PREPARE_E2E_STEP = "Prepare E2E workspace";

const CHECKOUT_LOCAL_PREPARE_E2E_ACTION = "./.github/actions/prepare-e2e";

const NO_BUILD_JOBS = new Set([
  "docs-validation",
  "generate-matrix",
  "hermes-root-entrypoint-smoke",
  "hermes-sandbox-secret-boundary",
  "launchable-smoke",
  "ollama-auth-proxy",
  "openshell-version-pin",
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
  "runtime-overrides",
  "shields-config",
  "snapshot-commands",
  "spark-install",
]);

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  uses?: string;
  with?: WorkflowRecord;
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

export function validatePrepareE2eAction(actionPath = DEFAULT_ACTION_PATH): string[] {
  const actionSource = readFileSync(actionPath, "utf8");
  const action = record(YAML.parse(actionSource));
  const errors: string[] = [];
  if (
    createHash("sha256").update(actionSource).digest("hex") !==
    PREPARE_E2E_ACTION_PROVENANCE.contentSha256
  ) {
    errors.push("prepare-e2e content must match the action reviewed at its immutable commit pin");
  }
  const expectedInput = {
    description: "Build the CLI after installing dependencies.",
    required: false,
    default: "true",
  };
  if (!isDeepStrictEqual(record(record(action.inputs)["build-cli"]), expectedInput)) {
    errors.push("prepare-e2e build-cli input must default to true");
  }
  if (Object.keys(record(action.inputs)).length !== 1) {
    errors.push("prepare-e2e must expose only the build-cli input");
  }

  const runs = record(action.runs);
  if (runs.using !== "composite") errors.push("prepare-e2e must be a composite action");
  const expectedSteps = [
    {
      name: "Set up Node",
      uses: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      with: { "node-version": 22, cache: "npm" },
    },
    {
      name: "Install root dependencies",
      shell: "bash",
      run: "npm ci --ignore-scripts",
    },
    {
      name: "Build CLI",
      if: "${{ inputs.build-cli == 'true' }}",
      shell: "bash",
      run: "npm run build:cli",
    },
  ];
  if (!isDeepStrictEqual(runs.steps, expectedSteps)) {
    errors.push("prepare-e2e must pin Node 22, run npm ci, and conditionally build the CLI");
  }
  return errors;
}

export function validatePrepareE2eInvocations(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const jobs = record(workflow.jobs);
  const expectedJobs = new Set(
    Object.entries(jobs)
      .filter(([jobName, value]) => {
        const job = record(value);
        return (
          jobName === "generate-matrix" || jobName === "live" || record(job.env).E2E_JOB === "1"
        );
      })
      .map(([jobName]) => jobName),
  );

  for (const [jobName, value] of Object.entries(jobs)) {
    const jobSteps = steps(record(value).steps);
    if (jobSteps.some((step) => step.uses === CHECKOUT_LOCAL_PREPARE_E2E_ACTION)) {
      errors.push(`${jobName} must not load prepare-e2e from the target checkout`);
    }
    const prepareSteps = jobSteps.filter((step) => step.uses === PREPARE_E2E_ACTION);
    if (!expectedJobs.has(jobName)) {
      if (prepareSteps.length > 0) errors.push(`${jobName} must not use prepare-e2e`);
      continue;
    }
    if (prepareSteps.length !== 1) {
      errors.push(`${jobName} must use prepare-e2e exactly once`);
      continue;
    }

    const prepare = prepareSteps[0];
    if (prepare.name !== PREPARE_E2E_STEP) {
      errors.push(`${jobName} prepare-e2e step must be named '${PREPARE_E2E_STEP}'`);
    }
    const withInputs = record(prepare.with);
    const shouldBuild = !NO_BUILD_JOBS.has(jobName);
    if (shouldBuild && Object.keys(withInputs).length !== 0) {
      errors.push(`${jobName} prepare-e2e must use the default CLI build`);
    }
    if (!shouldBuild && !isDeepStrictEqual(withInputs, { "build-cli": "false" })) {
      errors.push(`${jobName} prepare-e2e must set build-cli to false`);
    }
    const allowedKeys = shouldBuild ? ["name", "uses"] : ["name", "uses", "with"];
    if (!isDeepStrictEqual(Object.keys(prepare).sort(), allowedKeys.sort())) {
      errors.push(`${jobName} prepare-e2e invocation must not override its canonical contract`);
    }

    for (const retiredStep of ["Set up Node", "Install root dependencies", "Build CLI"]) {
      if (jobSteps.some((step) => step.name === retiredStep)) {
        errors.push(`${jobName} must not duplicate prepare-e2e step '${retiredStep}'`);
      }
    }
    const checkoutIndex = jobSteps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const prepareIndex = jobSteps.indexOf(prepare);
    if (checkoutIndex < 0 || prepareIndex <= checkoutIndex) {
      errors.push(`${jobName} must check out the repository before prepare-e2e`);
    }
    const authIndex = jobSteps.findIndex((step) => step.name === "Authenticate to Docker Hub");
    if (authIndex >= 0 && prepareIndex <= authIndex) {
      errors.push(`${jobName} must authenticate to Docker Hub before prepare-e2e`);
    }
  }

  for (const jobName of NO_BUILD_JOBS) {
    if (!expectedJobs.has(jobName)) errors.push(`prepare-e2e no-build job is missing: ${jobName}`);
  }
  return errors;
}

export function validatePrepareE2eWorkflowBoundary(
  workflow: WorkflowRecord,
  actionPath = DEFAULT_ACTION_PATH,
): string[] {
  return [...validatePrepareE2eAction(actionPath), ...validatePrepareE2eInvocations(workflow)];
}
