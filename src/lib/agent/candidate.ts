// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  type CandidateManagedImageAgent,
  isCandidateManagedImageAgent,
  isShippedManagedImageAgent,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
} from "../onboard/managed-image/contract";

export const CANDIDATE_AGENT_FEATURE_ENV = "NEMOCLAW_CANDIDATE_AGENTS" as const;
export const CANDIDATE_QUALIFICATION_RECEIPT_ENV =
  "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT" as const;
export const CANDIDATE_QUALIFICATION_RECEIPT_SHA256_ENV =
  "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT_SHA256" as const;

const MAX_RECEIPT_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class CandidateQualificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Candidate qualification authority is unavailable: ${message}`, options);
    this.name = "CandidateQualificationError";
  }
}

export function isCandidateAgent(name: string): name is CandidateManagedImageAgent {
  return isCandidateManagedImageAgent(name);
}

function receiptInputs(env: NodeJS.ProcessEnv): { path: string; sha256: string } | null {
  if (env[CANDIDATE_AGENT_FEATURE_ENV] !== "1") return null;
  const path = env[CANDIDATE_QUALIFICATION_RECEIPT_ENV];
  const sha256 = env[CANDIDATE_QUALIFICATION_RECEIPT_SHA256_ENV];
  if (!path || !sha256 || !SHA256_PATTERN.test(sha256)) return null;
  return { path, sha256 };
}

/**
 * A candidate agent is selectable only when the protected flag is set and the
 * process also holds a qualification receipt. The flag alone never activates a
 * withheld agent, so ordinary user environment configuration cannot reach it.
 */
export function isCandidateAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return receiptInputs(env) !== null;
}

export function isCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCandidateAgent(name) && isCandidateAgentEnabled(env);
}

export function candidateAgentUnavailableMessage(name: string): string {
  return `Agent '${name}' is a release candidate and is not selectable in this release`;
}

export function requireCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isCandidateAgent(name) && !isCandidateAgentEnabled(env)) {
    throw new Error(candidateAgentUnavailableMessage(name));
  }
}

function readBoundedReceipt(receiptPath: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(receiptPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const metadata = fs.fstatSync(descriptor);
    const pathMetadata = fs.lstatSync(receiptPath);
    if (
      pathMetadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.size < 2 ||
      metadata.size > MAX_RECEIPT_BYTES
    ) {
      throw new CandidateQualificationError("the receipt must be a bounded regular file");
    }
    return fs.readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof CandidateQualificationError) throw error;
    throw new CandidateQualificationError("the receipt could not be read", { cause: error });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/**
 * Resolve the exact managed-image contract that authorises a candidate agent.
 *
 * The receipt is pinned by digest and revalidated through the shared
 * managed-image contract parser, so it must name the canonical NVIDIA
 * repository for that candidate and carry an exact image digest. A receipt that
 * claims a shipped agent fails closed.
 */
export function readCandidateQualificationReceipt(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedImageContractV1 {
  const inputs = receiptInputs(env);
  if (!inputs) {
    throw new CandidateQualificationError(
      `agent '${name}' requires a protected candidate qualification receipt`,
    );
  }
  if (!isCandidateAgent(name)) {
    throw new CandidateQualificationError(`agent '${name}' is not a release candidate`);
  }
  const contents = readBoundedReceipt(inputs.path);
  const actual = createHash("sha256").update(contents, "utf8").digest("hex");
  if (actual !== inputs.sha256) {
    throw new CandidateQualificationError("the receipt does not match its pinned digest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new CandidateQualificationError("the receipt is not valid JSON", { cause: error });
  }
  let contract: ManagedImageContractV1;
  try {
    contract = parseManagedImageContractV1(parsed, name);
  } catch (error) {
    throw new CandidateQualificationError("the receipt failed closed contract validation", {
      cause: error,
    });
  }
  if (isShippedManagedImageAgent(contract.agent)) {
    throw new CandidateQualificationError(
      `'${contract.agent}' is already shipped and cannot qualify as a candidate`,
    );
  }
  return contract;
}

export function isCandidateQualificationEnabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    readCandidateQualificationReceipt(name, env);
    return true;
  } catch {
    return false;
  }
}

export function requireCandidateQualificationEnabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  requireCandidateAgentSelectable(name, env);
  if (isCandidateAgent(name)) readCandidateQualificationReceipt(name, env);
}
