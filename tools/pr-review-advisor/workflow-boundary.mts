// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "pr-review-advisor.yaml");

type WorkflowRecord = Record<string, unknown>;

type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value.filter((entry) => asRecord(entry) === entry) as WorkflowStep[]) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function usesPinnedAction(uses: string): boolean {
  return /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}(?:\s*#.*)?$/.test(uses);
}

function requireStep(
  errors: string[],
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const step = namedStep(steps, name);
  if (!step) errors.push(`missing workflow step: ${name}`);
  return step;
}

function requireStepWith(
  errors: string[],
  step: WorkflowStep | undefined,
  key: string,
  expected: string | boolean,
): void {
  if (!step) return;
  const actual = asRecord(step.with)[key];
  if (actual !== expected) {
    errors.push(`step '${step.name ?? "<unnamed>"}' expected with.${key}=${String(expected)}`);
  }
}

function requireRunContains(
  errors: string[],
  step: WorkflowStep | undefined,
  expected: string,
): void {
  if (!step) return;
  const run = stringValue(step.run);
  if (!run.includes(expected)) {
    errors.push(`step '${step.name ?? "<unnamed>"}' run script must include ${expected}`);
  }
}

export function validatePrReviewAdvisorWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const errors: string[] = [];
  let workflow: WorkflowRecord;
  try {
    workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  } catch {
    errors.push(`failed to read or parse workflow: ${workflowPath}`);
    return errors;
  }

  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);
  if (!Object.hasOwn(triggers, "pull_request")) {
    errors.push("workflow must run on pull_request, not only trusted-target events");
  }
  if (Object.hasOwn(triggers, "pull_request_target")) {
    errors.push("workflow must not run untrusted PR code under pull_request_target");
  }

  const reviewJob = asRecord(asRecord(workflow.jobs).review);
  const steps = asSteps(reviewJob.steps);
  if (steps.length === 0) errors.push("review job must declare steps");

  for (const step of steps) {
    if (step.uses && !usesPinnedAction(step.uses)) {
      errors.push(`step '${step.name ?? step.uses}' must pin action uses to a full commit SHA`);
    }
  }

  const trustedCheckout = requireStep(errors, steps, "Checkout trusted advisor code (main)");
  requireStepWith(errors, trustedCheckout, "repository", "NVIDIA/NemoClaw");
  requireStepWith(errors, trustedCheckout, "ref", "main");
  requireStepWith(errors, trustedCheckout, "path", "advisor");
  requireStepWith(errors, trustedCheckout, "persist-credentials", false);

  const prCheckout = requireStep(errors, steps, "Checkout PR workspace (read-only data)");
  requireStepWith(errors, prCheckout, "path", "pr-workdir");
  requireStepWith(errors, prCheckout, "persist-credentials", false);
  const prRef = stringValue(asRecord(prCheckout?.with).ref).trim();
  if (prRef !== "${{ github.event.pull_request.head.sha }}") {
    errors.push("PR checkout must use the pull request head SHA as inert analysis data");
  }

  const dispatchCheckout = requireStep(errors, steps, "Checkout dispatch workspace (read-only data)");
  requireStepWith(errors, dispatchCheckout, "path", "pr-workdir");
  requireStepWith(errors, dispatchCheckout, "persist-credentials", false);

  const install = requireStep(errors, steps, "Install Pi SDK");
  requireRunContains(errors, install, "--ignore-scripts");
  requireRunContains(errors, install, "$ADVISOR_DIR/node_modules");

  const analyze = requireStep(errors, steps, "Run PR review advisor");
  requireRunContains(errors, analyze, "cd \"$ADVISOR_WORKDIR\"");
  requireRunContains(errors, analyze, "$ADVISOR_DIR/tools/pr-review-advisor/analyze.mts");
  requireRunContains(errors, analyze, "$ADVISOR_DIR/tools/pr-review-advisor/schema.json");

  const comment = requireStep(errors, steps, "Post PR review advisor comment");
  requireRunContains(errors, comment, "$ADVISOR_DIR/tools/pr-review-advisor/comment.mts");

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");
  if (booleanValue(reviewJob["continue-on-error"]) === true) {
    errors.push("review job must not be globally continue-on-error");
  }

  return errors;
}
