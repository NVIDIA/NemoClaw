// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

import YAML from "yaml";

import { SHARED_E2E_JOB_ID } from "./credential-free-tests.mts";
import {
  type FreeStandingJobsInventory,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";

const E2E_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function usage(): string {
  return [
    "Usage: npx tsx tools/e2e/workflow-inventory.mts [--shell] [--workflow PATH]",
    "",
    "Derives E2E test IDs from tagged tests and workflow jobs.",
    "  --shell  Emit the four-key inventory consumed by the current base E2E workflow.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): {
  baseWorkflowFormat: boolean;
  workflowPath?: string;
} {
  const parsed: { baseWorkflowFormat: boolean; workflowPath?: string } = {
    baseWorkflowFormat: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--shell") {
      parsed.baseWorkflowFormat = true;
      continue;
    }
    if (arg === "--workflow") {
      const workflowPath = argv[index + 1];
      if (!workflowPath) throw new Error("--workflow requires a path");
      parsed.workflowPath = workflowPath;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function currentBaseE2eWorkflowJobIds(): Set<string> {
  const eventSha = process.env.GITHUB_SHA;
  const baseRef =
    process.env.GITHUB_REF === "refs/heads/main" && SHA_PATTERN.test(eventSha ?? "")
      ? (eventSha ?? "")
      : "origin/main";
  const source = execFileSync("git", ["show", `${baseRef}:${E2E_WORKFLOW_PATH}`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const workflow = YAML.parse(source) as unknown;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error(`Current base ${E2E_WORKFLOW_PATH} must be an object`);
  }
  const jobs = (workflow as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error(`Current base ${E2E_WORKFLOW_PATH} must define jobs`);
  }
  return new Set(Object.keys(jobs));
}

function formatCurrentBaseE2eWorkflowInventory(
  inventory: FreeStandingJobsInventory,
  currentBaseJobIds: ReadonlySet<string>,
): string {
  // `pr-e2e-gate.mts` dispatches `.github/workflows/e2e.yaml` from `main`
  // with `checkout_sha` set to the PR head. The current base workflow
  // therefore executes this PR's `workflow-inventory.mts --shell`.
  // Keep this four-key output until the planner-based workflow is on
  // `main`; then delete this CLI.
  // Only tagged tests with discrete jobs in that workflow remain selectable;
  // newer tagged tests must wait for the shared job instead of scheduling no work.
  const supportedByCurrentBase = (testId: string): boolean => {
    const job = inventory.targetToJob.get(testId);
    return job !== SHARED_E2E_JOB_ID || currentBaseJobIds.has(testId);
  };
  const targetJobMappings = [...inventory.targetToJob]
    .filter(([target]) => supportedByCurrentBase(target))
    .map(([target, job]) => `${target}:${job === SHARED_E2E_JOB_ID ? target : job}`);
  return [
    `allowed_jobs=${inventory.allowedJobs.filter(supportedByCurrentBase).join(",")}`,
    `explicit_only_jobs_csv=${inventory.explicitOnlyJobs.join(",")}`,
    `free_standing_targets_csv=${inventory.freeStandingTargets.filter(supportedByCurrentBase).join(",")}`,
    `free_standing_target_jobs_csv=${targetJobMappings.join(",")}`,
    "",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const inventory = readFreeStandingJobsInventory(options.workflowPath);
  if (options.baseWorkflowFormat) {
    process.stdout.write(
      formatCurrentBaseE2eWorkflowInventory(inventory, currentBaseE2eWorkflowJobIds()),
    );
  } else {
    process.stdout.write(
      `${JSON.stringify(
        {
          allowedJobs: inventory.allowedJobs,
          workflowJobs: inventory.workflowJobs,
          explicitOnlyJobs: inventory.explicitOnlyJobs,
          freeStandingTargets: inventory.freeStandingTargets,
          targetJobs: Object.fromEntries(inventory.targetToJob),
        },
        null,
        2,
      )}\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  for (const line of message.split("\n")) {
    console.error(`::error::${line}`);
  }
  process.exitCode = 1;
}
