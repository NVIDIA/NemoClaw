#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { replaceControlCharacters } from "../advisors/canonical-json.mts";
import {
  assertRepairContractSchema,
  CANONICAL_REPOSITORY,
  RepairContractError,
  sanitizeDiagnostic,
  sha256,
} from "./contract.mts";

export type AttemptReceipt = {
  version: 1;
  phase: "phase1-manual-publication";
  repository: typeof CANONICAL_REPOSITORY;
  workflow: {
    runId: number;
    runAttempt: number;
    workflowSha: string;
  };
  dispatch: {
    actor: string;
    triggeringActor: string;
    prNumber: number | null;
    advisorRunId: number | null;
    productScopeKind: string;
    productScopeIdentity: string;
    findingIdsSha256: string;
    repositoryEgressAuthorized: boolean;
  };
  emergencySwitch: {
    variable: "ADVISOR_REPAIR_PHASE1_ENABLED";
    enabled: boolean;
  };
  outcome: "gate-enabled" | "disabled";
  reason:
    | "enabled"
    | "emergency-switch-disabled"
    | "repository-egress-not-authorized"
    | "workflow-rerun-disabled"
    | "dispatch-actor-mismatch";
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function bounded(value: string | undefined, maximum: number): string {
  if (!value) return "";
  return replaceControlCharacters(value).trim().slice(0, maximum);
}

export function createAttemptReceipt(env: NodeJS.ProcessEnv): AttemptReceipt {
  const switchEnabled = env.PHASE1_ENABLED === "true";
  const workflowSha = required(env, "GITHUB_WORKFLOW_SHA");
  if (!/^[0-9a-f]{40}$/u.test(workflowSha)) {
    throw new RepairContractError("GITHUB_WORKFLOW_SHA must be a full SHA");
  }
  const runId = positiveInteger(env.GITHUB_RUN_ID);
  const runAttempt = positiveInteger(env.GITHUB_RUN_ATTEMPT);
  if (!runId || !runAttempt) throw new RepairContractError("workflow run identity is invalid");
  const actor = bounded(required(env, "GITHUB_ACTOR"), 256);
  const triggeringActor = bounded(required(env, "GITHUB_TRIGGERING_ACTOR"), 256);
  const repositoryEgressAuthorized = env.REPOSITORY_EGRESS_AUTHORIZED === "true";
  const reason: AttemptReceipt["reason"] = !switchEnabled
    ? "emergency-switch-disabled"
    : !repositoryEgressAuthorized
      ? "repository-egress-not-authorized"
      : runAttempt !== 1
        ? "workflow-rerun-disabled"
        : actor !== triggeringActor
          ? "dispatch-actor-mismatch"
          : "enabled";
  const receipt: AttemptReceipt = {
    version: 1,
    phase: "phase1-manual-publication",
    repository: CANONICAL_REPOSITORY,
    workflow: { runId, runAttempt, workflowSha },
    dispatch: {
      actor,
      triggeringActor,
      prNumber: positiveInteger(env.PR_NUMBER),
      advisorRunId: positiveInteger(env.ADVISOR_RUN_ID),
      productScopeKind: bounded(env.PRODUCT_SCOPE_KIND, 64),
      productScopeIdentity: bounded(env.PRODUCT_SCOPE_IDENTITY, 256),
      findingIdsSha256: sha256(env.FINDING_IDS_JSON ?? ""),
      repositoryEgressAuthorized,
    },
    emergencySwitch: {
      variable: "ADVISOR_REPAIR_PHASE1_ENABLED",
      enabled: switchEnabled,
    },
    outcome: reason === "enabled" ? "gate-enabled" : "disabled",
    reason,
  };
  assertRepairContractSchema("attempt-receipt", receipt);
  return receipt;
}

function main(env: NodeJS.ProcessEnv): void {
  const receipt = createAttemptReceipt(env);
  const outputDirectory = required(env, "AUDIT_OUTPUT_DIR");
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(outputDirectory, "attempt-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  fs.appendFileSync(
    required(env, "GITHUB_OUTPUT"),
    `enabled=${receipt.outcome === "gate-enabled"}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.env);
  } catch (error) {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  }
}
