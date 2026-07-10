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
  return Array.isArray(value)
    ? (value.filter((entry) => asRecord(entry) === entry) as WorkflowStep[])
    : [];
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

function requireRunOrders(
  errors: string[],
  step: WorkflowStep | undefined,
  before: string,
  after: string,
): void {
  if (!step) return;
  const run = stringValue(step.run);
  const beforeIndex = run.indexOf(before);
  const afterIndex = run.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex > afterIndex) {
    errors.push(
      `step '${step.name ?? "<unnamed>"}' run script must check ${before} before ${after}`,
    );
  }
}

function requireJobEnvValue(
  errors: string[],
  job: WorkflowRecord,
  key: string,
  expected: string,
): void {
  const actual = asRecord(job.env)[key];
  if (actual !== expected) {
    errors.push(`review job env.${key} must be ${expected}`);
  }
}

function advisorMatrixEntries(errors: string[], reviewJob: WorkflowRecord): WorkflowRecord[] {
  const advisor = asRecord(asRecord(reviewJob.strategy).matrix).advisor;
  if (Array.isArray(advisor)) {
    const entries = advisor.filter((entry) => asRecord(entry) === entry) as WorkflowRecord[];
    if (entries.length < 2) errors.push("advisor matrix must include at least two lanes");
    return entries;
  }
  errors.push("advisor matrix must declare strategy.matrix.advisor entries");
  return [];
}

function requireUniqueAdvisorMatrixField(
  errors: string[],
  entries: readonly WorkflowRecord[],
  field: string,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const value = stringValue(entry[field]).trim();
    if (!value) {
      errors.push(`advisor matrix entry ${index + 1} missing ${field}`);
      continue;
    }
    if (seen.has(value)) errors.push(`advisor matrix field ${field} must be unique: ${value}`);
    seen.add(value);
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
  if (stringValue(reviewJob["runs-on"]) !== "ubuntu-24.04") {
    errors.push("review job must pin the Ubuntu runner used by runtime package versions");
  }
  const advisorEntries = advisorMatrixEntries(errors, reviewJob);
  for (const field of ["model", "artifact_dir", "artifact_name", "comment_marker"]) {
    requireUniqueAdvisorMatrixField(errors, advisorEntries, field);
  }
  requireJobEnvValue(errors, reviewJob, "PR_REVIEW_ADVISOR_MODEL", "${{ matrix.advisor.model }}");
  requireJobEnvValue(errors, reviewJob, "RIPGREP_VERSION", "14.1.0-1");
  requireJobEnvValue(
    errors,
    reviewJob,
    "PR_REVIEW_ADVISOR_ARTIFACT_DIR",
    "${{ matrix.advisor.artifact_dir }}",
  );
  requireJobEnvValue(
    errors,
    reviewJob,
    "PR_REVIEW_ADVISOR_COMMENT_MARKER",
    "${{ matrix.advisor.comment_marker }}",
  );
  requireJobEnvValue(
    errors,
    reviewJob,
    "PR_REVIEW_ADVISOR_COMMENT_TITLE",
    "${{ matrix.advisor.comment_title }}",
  );
  requireJobEnvValue(
    errors,
    reviewJob,
    "PR_REVIEW_ADVISOR_COMMENT_LABEL",
    "${{ matrix.advisor.comment_label }}",
  );

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

  const dispatchCheckout = requireStep(
    errors,
    steps,
    "Checkout dispatch workspace (read-only data)",
  );
  requireStepWith(errors, dispatchCheckout, "path", "pr-workdir");
  requireStepWith(errors, dispatchCheckout, "persist-credentials", false);

  const targetCheckout = requireStep(errors, steps, "Prepare target PR checkout");
  requireRunContains(errors, targetCheckout, '[[ ! "$TARGET_REPO" =~ ^[A-Za-z0-9_.-]+/');
  requireRunContains(errors, targetCheckout, '[[ ! "$TARGET_PR" =~ ^[0-9]+$ ]]');
  const targetBaseGuards = [
    '-z "$TARGET_BASE"',
    '"$TARGET_BASE" == -*',
    '"$TARGET_BASE" == /*',
    '"$TARGET_BASE" == *..*',
    '"$TARGET_BASE" == *:*',
    '"$TARGET_BASE" =~ [[:space:]]',
    '! "$TARGET_BASE" =~ ^[A-Za-z0-9._/-]+$',
  ];
  for (const guard of targetBaseGuards) {
    requireRunContains(errors, targetCheckout, guard);
    requireRunOrders(
      errors,
      targetCheckout,
      guard,
      'git -C "$TARGET_DIR" fetch --no-tags target "$TARGET_BASE"',
    );
  }
  requireRunOrders(
    errors,
    targetCheckout,
    '[[ ! "$TARGET_REPO" =~',
    'git -C "$TARGET_DIR" remote add target',
  );
  requireRunOrders(
    errors,
    targetCheckout,
    '[[ ! "$TARGET_PR" =~',
    'git -C "$TARGET_DIR" fetch --no-tags target "pull/${TARGET_PR}/head',
  );
  const install = requireStep(errors, steps, "Install Pi SDK");
  requireRunContains(
    errors,
    install,
    'sudo apt-get install -y --no-install-recommends "ripgrep=${RIPGREP_VERSION}"',
  );
  requireRunContains(errors, install, "rg --version");
  requireRunContains(errors, install, "--ignore-scripts");
  requireRunContains(errors, install, "$ADVISOR_DIR/node_modules");

  const analyze = requireStep(errors, steps, "Run PR review advisor");
  requireRunContains(errors, analyze, 'cd "$ADVISOR_WORKDIR"');
  requireRunContains(errors, analyze, "$ADVISOR_DIR/tools/pr-review-advisor/analyze.mts");
  requireRunContains(errors, analyze, "$ADVISOR_DIR/tools/pr-review-advisor/schema.json");
  requireRunContains(errors, analyze, "$PR_REVIEW_ADVISOR_MODEL");
  requireRunContains(errors, analyze, "PR_REVIEW_ADVISOR_SUPPORTED=0");
  requireRunContains(errors, analyze, "PR_REVIEW_ADVISOR_RUN_ANALYSIS=0");
  requireRunContains(errors, analyze, "PR_REVIEW_ADVISOR_UNAVAILABLE_REASON");
  requireRunContains(errors, analyze, "trusted main checkout does not yet support");
  if (analyze) {
    if (booleanValue(analyze["continue-on-error"]) !== true) {
      errors.push(
        "Run PR review advisor must continue-on-error until summaries, comments, and artifacts are published",
      );
    }
    const analyzeEnv = asRecord(analyze.env);
    if (
      stringValue(analyzeEnv.PR_REVIEW_ADVISOR_API_KEY).trim() !==
      "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}"
    ) {
      errors.push(
        "Run PR review advisor must receive PR_REVIEW_ADVISOR_API_KEY only from secrets.PR_REVIEW_ADVISOR_API_KEY",
      );
    }
    if (Object.hasOwn(analyzeEnv, "OPENAI_API_KEY")) {
      errors.push("Run PR review advisor must not receive OPENAI_API_KEY");
    }
  }

  const comment = requireStep(errors, steps, "Post PR review advisor comment");
  requireRunContains(errors, comment, "$ADVISOR_DIR/tools/pr-review-advisor/comment.mts");
  requireRunContains(errors, comment, "PR_REVIEW_ADVISOR_SUPPORTED");
  requireRunOrders(
    errors,
    comment,
    'if [ "${PR_REVIEW_ADVISOR_SUPPORTED:-1}" = "0" ]',
    "$ADVISOR_DIR/tools/pr-review-advisor/comment.mts",
  );
  requireRunContains(errors, comment, '--marker "$PR_REVIEW_ADVISOR_COMMENT_MARKER"');
  requireRunContains(errors, comment, '--title "$PR_REVIEW_ADVISOR_COMMENT_TITLE"');
  requireRunContains(errors, comment, '--label "$PR_REVIEW_ADVISOR_COMMENT_LABEL"');

  const outcome = requireStep(errors, steps, "Verify advisor analysis outcome");
  if (outcome) {
    if (booleanValue(outcome["continue-on-error"]) === true) {
      errors.push("Verify advisor analysis outcome must not continue on error");
    }
    if (stringValue(outcome.if).trim() !== "always()") {
      errors.push("Verify advisor analysis outcome must run with if: always()");
    }
    if (
      stringValue(asRecord(outcome.env).ANALYSIS_OUTCOME).trim() !== "${{ steps.analysis.outcome }}"
    ) {
      errors.push(
        "Verify advisor analysis outcome must read ANALYSIS_OUTCOME from steps.analysis.outcome",
      );
    }
  }
  requireRunContains(errors, outcome, 'if [ "$ANALYSIS_OUTCOME" != "success" ]');
  requireRunContains(errors, outcome, "exit 1");
  const uploadIndex = steps.findIndex((step) => step.name === "Upload advisor artifacts");
  const outcomeIndex = steps.findIndex((step) => step.name === "Verify advisor analysis outcome");
  if (uploadIndex >= 0 && outcomeIndex >= 0 && outcomeIndex < uploadIndex) {
    errors.push("Verify advisor analysis outcome must run after Upload advisor artifacts");
  }

  const permissions = asRecord(workflow.permissions);
  if (permissions.contents !== "read") errors.push("workflow permissions.contents must be read");
  if (booleanValue(reviewJob["continue-on-error"]) === true) {
    errors.push("review job must not be globally continue-on-error");
  }

  return errors;
}
