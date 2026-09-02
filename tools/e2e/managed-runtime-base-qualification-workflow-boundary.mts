// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { name?: string; run?: string };

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(job: WorkflowRecord): WorkflowStep[] {
  return Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
}

function requireStep(
  errors: string[],
  job: WorkflowRecord,
  jobId: string,
  name: string,
): WorkflowStep | undefined {
  const matches = steps(job).filter((step) => step.name === name);
  if (matches.length !== 1) errors.push(`${jobId} must define exactly one '${name}' step`);
  return matches[0];
}

function requireFragments(
  errors: string[],
  jobId: string,
  step: WorkflowStep | undefined,
  fragments: readonly string[],
): void {
  const run = typeof step?.run === "string" ? step.run : "";
  for (const fragment of fragments) {
    if (!run.includes(fragment))
      errors.push(`${jobId} step '${step?.name}' must include ${fragment}`);
  }
}

const NATIVE_MATRIX = {
  include: [
    { arch: "amd64", platform: "linux/amd64", runner: "ubuntu-24.04" },
    { arch: "arm64", platform: "linux/arm64", runner: "ubuntu-24.04-arm" },
  ],
};

/** Validate the native-platform and candidate-write isolation boundaries of exact-base qualification. */
export function validateManagedRuntimeBaseQualificationWorkflow(
  workflow: WorkflowRecord,
): string[] {
  const errors: string[] = [];
  const jobs = record(workflow.jobs);
  const build = record(jobs["build-candidate-cli"]);
  const candidate = record(jobs["trusted-candidate-activation"]);
  const authenticate = record(jobs["authenticate-candidate-evidence"]);
  const base = record(jobs["exact-base-activation"]);
  const classify = record(jobs.classify);

  if (Object.keys(build).length === 0) errors.push("workflow must isolate the candidate CLI build");
  if (!isDeepStrictEqual(record(record(candidate.strategy).matrix), NATIVE_MATRIX)) {
    errors.push("candidate activation must use the complete native platform matrix");
  }
  if (!isDeepStrictEqual(record(record(base.strategy).matrix), NATIVE_MATRIX)) {
    errors.push("base activation must use the complete native platform matrix");
  }
  const authenticationMatrix = record(record(authenticate.strategy).matrix);
  if (
    !isDeepStrictEqual(authenticationMatrix, {
      include: NATIVE_MATRIX.include.map(({ arch, platform }) => ({ arch, platform })),
    })
  ) {
    errors.push("candidate evidence authentication must cover both native platforms");
  }
  if (!Array.isArray(candidate.needs) || !candidate.needs.includes("build-candidate-cli")) {
    errors.push("candidate activation must consume the isolated CLI build");
  }
  if (steps(candidate).some((step) => step.run?.includes("npm run build:cli"))) {
    errors.push("candidate activation must not execute candidate build scripts");
  }

  requireFragments(
    errors,
    "trusted-candidate-activation",
    requireStep(
      errors,
      candidate,
      "trusted-candidate-activation",
      "Materialize and isolate the candidate product",
    ),
    [
      "sudo useradd --system",
      "sudo chown -R root:root trusted candidate",
      "sudo chmod -R a-w trusted candidate",
      'chmod 0700 "$E2E_ARTIFACT_DIR"',
      "sudo --preserve-env -u nemoclaw-candidate",
    ],
  );
  requireFragments(
    errors,
    "trusted-candidate-activation",
    requireStep(
      errors,
      candidate,
      "trusted-candidate-activation",
      "Reject candidate writes to controller and evidence boundaries",
    ),
    [
      'if sudo -u nemoclaw-candidate -- touch "$GITHUB_WORKSPACE/trusted/.candidate-tamper"',
      'if sudo -u nemoclaw-candidate -- touch "$E2E_ARTIFACT_DIR/.candidate-tamper"',
      "exit 1",
    ],
  );
  requireFragments(
    errors,
    "classify",
    requireStep(errors, classify, "classify", "Compare authenticated scenario receipts"),
    ["for arch in amd64 arm64; do", 'test "$overall" = pass'],
  );
  return errors;
}
