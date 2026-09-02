#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  MAX_PATCH_BYTES,
  parseValidatedReceiptForPublication,
  readBoundedJson,
  readBoundedRegularFile,
  RepairContractError,
  sanitizeDiagnostic,
  type ValidationReceipt,
} from "./contract.mts";
import { validateMaintainerPermission, type GitHubRequest } from "./select.mts";

const REPAIR_WORKFLOW_NAME = "Automation / PR Review Advisor Repair";
const REPAIR_WORKFLOW_PATH = ".github/workflows/pr-review-advisor-repair.yaml";
const MAX_VALIDATION_ARTIFACT_BYTES = 2 * 1024 * 1024;

type WorkflowRun = {
  id?: unknown;
  run_attempt?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  name?: unknown;
  path?: unknown;
  head_branch?: unknown;
  repository?: { full_name?: unknown };
};

type Artifact = {
  id?: unknown;
  name?: unknown;
  expired?: unknown;
  size_in_bytes?: unknown;
  digest?: unknown;
  workflow_run?: { id?: unknown };
};

export type ReconciliationSource = Readonly<{
  sourceRunId: number;
  sourceRunAttempt: 1;
  validationArtifactId: number;
  validationArtifactDigest: string;
}>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) {
    throw new RepairContractError(`${label} must be a positive integer`);
  }
  return Number(parsed);
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new RepairContractError(`${label} must be a full SHA`);
  }
  return value;
}

export async function collectReconciliationSource(input: {
  sourceRunId: number;
  validationArtifactId: number;
  actor: string;
  triggeringActor: string;
  token: string;
  request?: GitHubRequest;
}): Promise<ReconciliationSource> {
  const request = input.request ?? githubApi;
  const actorPermission = await request<Parameters<typeof validateMaintainerPermission>[0]>(
    `repos/${CANONICAL_REPOSITORY}/collaborators/${encodeURIComponent(input.actor)}/permission`,
    input.token,
  );
  validateMaintainerPermission(actorPermission, input.actor);
  if (input.triggeringActor !== input.actor) {
    const triggeringPermission = await request<Parameters<typeof validateMaintainerPermission>[0]>(
      `repos/${CANONICAL_REPOSITORY}/collaborators/${encodeURIComponent(input.triggeringActor)}/permission`,
      input.token,
    );
    validateMaintainerPermission(triggeringPermission, input.triggeringActor);
  }
  const run = await request<WorkflowRun>(
    `repos/${CANONICAL_REPOSITORY}/actions/runs/${input.sourceRunId}`,
    input.token,
  );
  if (
    run.id !== input.sourceRunId ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    !["success", "failure", "cancelled", "timed_out"].includes(String(run.conclusion)) ||
    run.name !== REPAIR_WORKFLOW_NAME ||
    run.path !== REPAIR_WORKFLOW_PATH ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError("reconciliation source is not an original completed repair run");
  }
  const artifact = await request<Artifact>(
    `repos/${CANONICAL_REPOSITORY}/actions/artifacts/${input.validationArtifactId}`,
    input.token,
  );
  const expectedName = `pr-review-advisor-repair-phase1-validation-${input.sourceRunId}-1`;
  const size = positiveInteger(artifact.size_in_bytes, "validation artifact size");
  if (
    artifact.id !== input.validationArtifactId ||
    artifact.name !== expectedName ||
    artifact.expired !== false ||
    size > MAX_VALIDATION_ARTIFACT_BYTES ||
    artifact.workflow_run?.id !== input.sourceRunId ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
  ) {
    throw new RepairContractError("validation artifact is not the exact bounded source-run bundle");
  }
  return {
    sourceRunId: input.sourceRunId,
    sourceRunAttempt: 1,
    validationArtifactId: input.validationArtifactId,
    validationArtifactDigest: artifact.digest,
  };
}

export function bindReconciliationBundle(input: {
  prNumber: number;
  sourceHeadSha: string;
  patchFile: string;
  receiptFile: string;
}): ValidationReceipt {
  const patch = readBoundedRegularFile(input.patchFile, MAX_PATCH_BYTES);
  const receipt = parseValidatedReceiptForPublication(
    readBoundedJson(input.receiptFile, 1024 * 1024),
    patch,
  );
  if (
    receipt.prNumber !== positiveInteger(input.prNumber, "reconciliation PR number") ||
    receipt.sourceHeadSha !== fullSha(input.sourceHeadSha, "reconciliation source head SHA")
  ) {
    throw new RepairContractError(
      "validation bundle does not match the authorized PR and source head",
    );
  }
  return receipt;
}

export function formatReconciliationBindingOutput(receipt: ValidationReceipt): string {
  return `attempt_key=${receipt.attemptKey}\nbase_sha=${receipt.baseSha}\nhead_ref=${receipt.headRef}\n`;
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const command = required(env, "RECONCILE_COMMAND");
  if (command === "collect") {
    if (env.ADVISOR_REPAIR_PHASE1_ENABLED !== "true") {
      throw new RepairContractError("Phase 1 reconciliation is disabled");
    }
    const source = await collectReconciliationSource({
      sourceRunId: positiveInteger(required(env, "SOURCE_RUN_ID"), "source run ID"),
      validationArtifactId: positiveInteger(
        required(env, "VALIDATION_ARTIFACT_ID"),
        "validation artifact ID",
      ),
      actor: required(env, "GITHUB_ACTOR"),
      triggeringActor: required(env, "GITHUB_TRIGGERING_ACTOR"),
      token: required(env, "GITHUB_TOKEN"),
    });
    fs.appendFileSync(
      required(env, "GITHUB_OUTPUT"),
      `validation_artifact_id=${source.validationArtifactId}\nvalidation_artifact_digest=${source.validationArtifactDigest}\n`,
    );
    return;
  }
  if (command === "bind") {
    const receipt = bindReconciliationBundle({
      prNumber: positiveInteger(required(env, "PR_NUMBER"), "PR number"),
      sourceHeadSha: required(env, "SOURCE_HEAD_SHA"),
      patchFile: required(env, "VALIDATED_PATCH_FILE"),
      receiptFile: required(env, "VALIDATION_RECEIPT_FILE"),
    });
    fs.appendFileSync(required(env, "GITHUB_OUTPUT"), formatReconciliationBindingOutput(receipt));
    return;
  }
  throw new RepairContractError(`unsupported reconciliation command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
