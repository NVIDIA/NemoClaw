// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_WORKFLOW_PATH = path.join(ROOT, ".github/workflows/e2e-main-runner-loss-retry.yaml");

export const MAIN_E2E_RETRY_JOB_IF =
  "${{ github.repository == 'NVIDIA/NemoClaw' && github.event.workflow_run.event != 'pull_request' && (github.event.workflow_run.event == 'schedule' || github.event.workflow_run.event == 'workflow_dispatch') && github.event.workflow_run.path == '.github/workflows/e2e.yaml' && github.event.workflow_run.display_title == 'E2E main' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt == 1 }}";
export const MAIN_E2E_RETRY_CHECKOUT = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
export const MAIN_E2E_RETRY_SETUP_NODE =
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
export const MAIN_E2E_RETRY_COMMAND =
  "node --experimental-strip-types tools/e2e/main-e2e-runner-loss-retry.mts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isExactRecord(value: unknown, expected: Record<string, unknown>): boolean {
  return isRecord(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

export function validateMainE2eRunnerLossRetryWorkflow(value: unknown): string[] {
  if (!isRecord(value)) return ["runner-loss retry workflow must be a mapping"];
  const errors: string[] = [];
  if (!hasExactKeys(value, ["name", "run-name", "on", "permissions", "jobs"])) {
    errors.push("runner-loss retry workflow must expose only its reviewed top-level keys");
  }
  if (value.name !== "E2E Main Runner Loss Retry") {
    errors.push("runner-loss retry workflow name must remain canonical");
  }
  if (
    value["run-name"] !==
    "E2E main runner-loss retry for run ${{ github.event.workflow_run.id }} attempt ${{ github.event.workflow_run.run_attempt }}"
  ) {
    errors.push("runner-loss retry run name must bind the subject run and attempt");
  }
  if (
    !isExactRecord(value.on, {
      workflow_run: { workflows: ["E2E"], types: ["completed"] },
    })
  ) {
    errors.push("runner-loss retry must trigger only after the E2E workflow completes");
  }
  if (!isExactRecord(value.permissions, {})) {
    errors.push("runner-loss retry must deny permissions at workflow scope");
  }
  if (!isRecord(value.jobs) || !hasExactKeys(value.jobs, ["classify-and-retry"])) {
    errors.push("runner-loss retry workflow must contain only classify-and-retry");
    return errors;
  }

  const job = value.jobs["classify-and-retry"];
  if (!isRecord(job)) {
    errors.push("classify-and-retry must be a job mapping");
    return errors;
  }
  if (
    !hasExactKeys(job, ["if", "runs-on", "timeout-minutes", "permissions", "concurrency", "steps"])
  ) {
    errors.push("classify-and-retry must expose only its reviewed job keys");
  }
  if (job.if !== MAIN_E2E_RETRY_JOB_IF) {
    errors.push("classify-and-retry must preserve the trusted first-attempt final-main guard");
  }
  if (job["runs-on"] !== "ubuntu-latest" || job["timeout-minutes"] !== 10) {
    errors.push("classify-and-retry must use the bounded hosted controller runner");
  }
  if (!isExactRecord(job.permissions, { actions: "write", contents: "read" })) {
    errors.push("classify-and-retry must keep its least-privilege permission boundary");
  }
  if (
    !isExactRecord(job.concurrency, {
      group: "e2e-main-runner-loss-retry-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    })
  ) {
    errors.push("classify-and-retry must serialize by subject run without cancellation");
  }
  if (!Array.isArray(job.steps) || job.steps.length !== 3 || !job.steps.every(isRecord)) {
    errors.push("classify-and-retry must contain exactly three reviewed steps");
    return errors;
  }
  const [checkout, setupNode, classify] = job.steps as Record<string, unknown>[];
  if (
    !hasExactKeys(checkout!, ["name", "uses", "with"]) ||
    checkout!.name !== "Checkout trusted retry controller" ||
    checkout!.uses !== MAIN_E2E_RETRY_CHECKOUT ||
    !isExactRecord(checkout!.with, {
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    })
  ) {
    errors.push("runner-loss retry must check out only the immutable trusted controller");
  }
  if (
    !hasExactKeys(setupNode!, ["name", "uses", "with"]) ||
    setupNode!.name !== "Setup Node" ||
    setupNode!.uses !== MAIN_E2E_RETRY_SETUP_NODE ||
    !isExactRecord(setupNode!.with, { "node-version": "22" })
  ) {
    errors.push("runner-loss retry must use the reviewed Node setup");
  }
  if (
    !hasExactKeys(classify!, ["name", "env", "run"]) ||
    classify!.name !== "Classify runner loss and retry failed jobs once" ||
    classify!.run !== MAIN_E2E_RETRY_COMMAND ||
    !isExactRecord(classify!.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      SUBJECT_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
      SUBJECT_RUN_ID: "${{ github.event.workflow_run.id }}",
    })
  ) {
    errors.push("runner-loss retry must invoke the trusted classifier with bounded metadata");
  }
  const strings = collectStrings(value);
  if (strings.some((candidate) => candidate.includes("${{ secrets."))) {
    errors.push("runner-loss retry must not receive repository secrets");
  }
  if (strings.some((candidate) => candidate.includes("workflow_run.head_sha"))) {
    errors.push("runner-loss retry must not execute code from the subject run SHA");
  }
  return errors;
}

export function validateMainE2eRunnerLossRetryWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  try {
    return validateMainE2eRunnerLossRetryWorkflow(
      YAML.parse(fs.readFileSync(workflowPath, "utf8")),
    );
  } catch (error) {
    return [
      `runner-loss retry workflow could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}
