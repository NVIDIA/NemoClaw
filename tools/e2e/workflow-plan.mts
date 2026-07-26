// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildLiveTargetMatrix, type LiveTargetMatrixEntry } from "../../test/e2e/registry/run.ts";
import {
  type CredentialFreeTestMatrixRow,
  discoverCredentialFreeTests,
} from "./credential-free-tests.mts";
import { readFreeStandingJobsInventory } from "./workflow-boundary.mts";

export type WorkflowPlanSelectors = {
  jobs?: string;
  targets?: string;
};

export type E2eWorkflowPlan = {
  matrix: LiveTargetMatrixEntry[];
  testMatrix: CredentialFreeTestMatrixRow[];
  hermesSelected: boolean;
  explicitOnlyJobs: string[];
};

type WorkflowPlanCliOptions = WorkflowPlanSelectors & {
  ciOutput: boolean;
};

const SAFE_SELECTOR_LIST_PATTERN = /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/;
const HERMES_JOB_ID = "hermes-e2e";
const LEGACY_BOOTSTRAP_INSTALL_JOB_ID = "launchable-smoke";
const BOOTSTRAP_INSTALL_JOB_ID = "bootstrap-install-smoke";
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const INFERENCE_MODES = new Set(["mock", "internal-nvidia", "public-nvidia"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isLiveTargetMatrixEntry(value: unknown): value is LiveTargetMatrixEntry {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "expectedStateId",
      "id",
      "install",
      "label",
      "onboarding",
      "pendingRuntimeSuites",
      "platform",
      "requiredSecrets",
      "runner",
      "runtime",
      "suites",
      "supportReasons",
      "supported",
    ])
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) &&
    typeof value.runner === "string" &&
    /^[A-Za-z0-9_-]+$/u.test(value.runner) &&
    typeof value.label === "string" &&
    typeof value.platform === "string" &&
    typeof value.install === "string" &&
    typeof value.runtime === "string" &&
    typeof value.onboarding === "string" &&
    typeof value.expectedStateId === "string" &&
    typeof value.supported === "boolean" &&
    isStringArray(value.suites) &&
    isStringArray(value.requiredSecrets) &&
    isStringArray(value.supportReasons) &&
    isStringArray(value.pendingRuntimeSuites)
  );
}

function isCredentialFreeTestMatrixRow(value: unknown): value is CredentialFreeTestMatrixRow {
  if (!isRecord(value) || !hasExactKeys(value, ["file", "id", "project"])) return false;
  if (
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
    typeof value.file !== "string" ||
    value.file.split("/").some((segment) => segment === "." || segment === "..") ||
    !/^test\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+[.]test[.](?:js|ts)$/u.test(value.file) ||
    typeof value.project !== "string"
  ) {
    return false;
  }
  return (
    (value.project === "e2e-live" && value.file.startsWith("test/e2e/live/")) ||
    (value.project === "integration" &&
      value.file.startsWith("test/") &&
      !value.file.startsWith("test/e2e/"))
  );
}

function hasUniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}

function selectorIds(value: string | undefined, label: "jobs" | "targets"): string[] {
  if (!value) return [];
  if (!SAFE_SELECTOR_LIST_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label} input; use comma-separated ids containing only letters, numbers, underscores, and hyphens`,
    );
  }
  return value.split(",");
}

function selectTestRows(
  rows: readonly CredentialFreeTestMatrixRow[],
  ids: readonly string[],
): CredentialFreeTestMatrixRow[] {
  if (ids.length === 0) return [...rows];
  const selected = new Set(ids);
  return rows.filter((row) => selected.has(row.id));
}

function mapTrustedControllerBootstrapJob(
  selectors: WorkflowPlanSelectors,
  environment: NodeJS.ProcessEnv,
): WorkflowPlanSelectors {
  if (!COMMIT_SHA_PATTERN.test(environment.NEMOCLAW_E2E_EXPECTED_SHA ?? "")) return selectors;

  const jobs = selectorIds(selectors.jobs, "jobs");
  if (!jobs.includes(LEGACY_BOOTSTRAP_INSTALL_JOB_ID)) return selectors;

  const inventory = readFreeStandingJobsInventory();
  if (!inventory.allowedJobs.includes(BOOTSTRAP_INSTALL_JOB_ID)) return selectors;

  // Trusted main selects the old job ID until this workflow rename merges, while
  // the checked-out PR planner already reads the renamed inventory.
  return {
    ...selectors,
    jobs: jobs
      .map((job) => (job === LEGACY_BOOTSTRAP_INSTALL_JOB_ID ? BOOTSTRAP_INSTALL_JOB_ID : job))
      .join(","),
  };
}

export function buildE2eWorkflowPlan(selectors: WorkflowPlanSelectors = {}): E2eWorkflowPlan {
  const jobs = selectorIds(selectors.jobs, "jobs");
  const targets = selectorIds(selectors.targets, "targets");

  const inventory = readFreeStandingJobsInventory();
  const credentialFreeTests = discoverCredentialFreeTests();

  if (jobs.length > 0) {
    const allowedJobs = new Set(inventory.allowedJobs);
    for (const job of jobs) {
      if (!allowedJobs.has(job)) {
        throw new Error(
          `Unknown E2E test ID: ${job}\nAllowed test IDs: ${inventory.allowedJobs.join(",")}`,
        );
      }
    }
  }

  if (jobs.length > 0 || targets.length > 0) {
    const registryTargets = targets.filter((target) => !inventory.targetToJob.has(target));
    return {
      matrix: registryTargets.length > 0 ? buildLiveTargetMatrix(registryTargets) : [],
      testMatrix: selectTestRows(credentialFreeTests, [...jobs, ...targets]),
      hermesSelected: [...jobs, ...targets].includes(HERMES_JOB_ID),
      explicitOnlyJobs: [...inventory.explicitOnlyJobs],
    };
  }

  return {
    matrix: buildLiveTargetMatrix(),
    testMatrix: credentialFreeTests,
    hermesSelected: true,
    explicitOnlyJobs: [...inventory.explicitOnlyJobs],
  };
}

export function validateE2eWorkflowPlan(plan: unknown): E2eWorkflowPlan {
  if (
    !isRecord(plan) ||
    !hasExactKeys(plan, ["matrix", "testMatrix", "hermesSelected", "explicitOnlyJobs"]) ||
    !Array.isArray(plan.matrix) ||
    !plan.matrix.every(isLiveTargetMatrixEntry) ||
    !Array.isArray(plan.testMatrix) ||
    !plan.testMatrix.every(isCredentialFreeTestMatrixRow) ||
    !hasUniqueIds([...plan.matrix, ...plan.testMatrix]) ||
    typeof plan.hermesSelected !== "boolean" ||
    !isStringArray(plan.explicitOnlyJobs) ||
    !plan.explicitOnlyJobs.every((job) => /^[A-Za-z0-9_-]+$/u.test(job)) ||
    new Set(plan.explicitOnlyJobs).size !== plan.explicitOnlyJobs.length
  ) {
    throw new Error("E2E planner returned an invalid output schema");
  }
  return plan as E2eWorkflowPlan;
}

function expectedHermesSelection(selectors: WorkflowPlanSelectors): boolean {
  const selected = [selectors.jobs, selectors.targets]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(","));
  return selected.length === 0 || selected.includes(HERMES_JOB_ID);
}

export function renderE2eWorkflowPlanSummary(plan: E2eWorkflowPlan): string {
  const lines = [
    "## E2E Execution Plan",
    "",
    "| Test | Execution | Runner |",
    "| --- | --- | --- |",
  ];
  for (const row of plan.matrix) {
    lines.push(`| \`${row.id}\` | typed registry | \`${row.runner}\` |`);
  }
  for (const row of plan.testMatrix) {
    lines.push(`| \`${row.id}\` | shared E2E job | \`ubuntu-latest\` |`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeE2eWorkflowPlanCiOutput(
  selectors: WorkflowPlanSelectors,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const inferenceMode = environment.INFERENCE_MODE ?? "";
  if (!INFERENCE_MODES.has(inferenceMode)) {
    throw new Error(`Invalid inference_mode: ${inferenceMode}`);
  }
  const plannerSelectors = mapTrustedControllerBootstrapJob(selectors, environment);
  const plan = validateE2eWorkflowPlan(buildE2eWorkflowPlan(plannerSelectors));
  if (plan.hermesSelected !== expectedHermesSelection(plannerSelectors)) {
    throw new Error("E2E planner changed the trusted Hermes selection");
  }
  const output = environment.GITHUB_OUTPUT;
  const summary = environment.GITHUB_STEP_SUMMARY;
  if (!output || !summary) throw new Error("GitHub output paths are required");
  appendFileSync(
    output,
    [
      `matrix=${JSON.stringify(plan.matrix)}`,
      `test_matrix=${JSON.stringify(plan.testMatrix)}`,
      `hermes_selected=${plan.hermesSelected}`,
      `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
      "",
    ].join("\n"),
  );
  appendFileSync(summary, renderE2eWorkflowPlanSummary(plan));
}

function parseArgs(argv: readonly string[]): WorkflowPlanCliOptions {
  const options: WorkflowPlanCliOptions = { ciOutput: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ci-output") {
      options.ciOutput = true;
      continue;
    }
    if (arg !== "--jobs" && arg !== "--targets") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--jobs") options.jobs = value;
    else options.targets = value;
    index += 1;
  }
  return options;
}

export function runE2eWorkflowPlanCli(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  if (options.ciOutput) {
    writeE2eWorkflowPlanCiOutput(
      { jobs: process.env.JOBS, targets: process.env.TARGETS },
      process.env,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(buildE2eWorkflowPlan(options))}\n`);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    runE2eWorkflowPlanCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n")) console.error(`::error::${line}`);
    process.exitCode = 1;
  }
}
