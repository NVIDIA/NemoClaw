// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

const SAFE_SELECTOR_LIST_PATTERN = /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/;
const HERMES_JOB_ID = "hermes-e2e";

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

export function buildE2eWorkflowPlan(selectors: WorkflowPlanSelectors = {}): E2eWorkflowPlan {
  const jobs = selectorIds(selectors.jobs, "jobs");
  const targets = selectorIds(selectors.targets, "targets");
  if (jobs.length > 0 && targets.length > 0) {
    throw new Error("Use either jobs or targets, not both");
  }

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

    return {
      matrix: [],
      testMatrix: selectTestRows(credentialFreeTests, jobs),
      hermesSelected: jobs.includes(HERMES_JOB_ID),
      explicitOnlyJobs: [...inventory.explicitOnlyJobs],
    };
  }

  if (targets.length > 0) {
    const registryTargets = targets.filter((target) => !inventory.targetToJob.has(target));
    return {
      matrix: registryTargets.length > 0 ? buildLiveTargetMatrix(registryTargets) : [],
      testMatrix: selectTestRows(credentialFreeTests, targets),
      hermesSelected: targets.includes(HERMES_JOB_ID),
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

function parseArgs(argv: readonly string[]): WorkflowPlanSelectors {
  const selectors: WorkflowPlanSelectors = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--jobs" && arg !== "--targets") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--jobs") selectors.jobs = value;
    else selectors.targets = value;
    index += 1;
  }
  return selectors;
}

export function runE2eWorkflowPlanCli(argv = process.argv.slice(2)): void {
  process.stdout.write(`${JSON.stringify(buildE2eWorkflowPlan(parseArgs(argv)))}\n`);
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
