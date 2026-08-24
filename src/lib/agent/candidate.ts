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
import { acceptedCandidateReceiptDigests } from "./candidate-authority";

export const CANDIDATE_AGENT_FEATURE_ENV = "NEMOCLAW_CANDIDATE_AGENTS" as const;
export const CANDIDATE_QUALIFICATION_RECEIPT_ENV =
  "NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT" as const;

const MAX_RECEIPT_BYTES = 64 * 1024;

export class CandidateQualificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Candidate qualification authority is unavailable: ${message}`, options);
    this.name = "CandidateQualificationError";
  }
}

export function isCandidateAgent(name: string): name is CandidateManagedImageAgent {
  return isCandidateManagedImageAgent(name);
}

function receiptPath(env: NodeJS.ProcessEnv): string | null {
  if (env[CANDIDATE_AGENT_FEATURE_ENV] !== "1") return null;
  return env[CANDIDATE_QUALIFICATION_RECEIPT_ENV] || null;
}

export function candidateAgentUnavailableMessage(name: string): string {
  return `Agent '${name}' is a release candidate and is not selectable in this release`;
}

function readBoundedReceipt(path: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const metadata = fs.fstatSync(descriptor);
    const pathMetadata = fs.lstatSync(path);
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
 * The caller supplies only the receipt location. Whether that receipt qualifies
 * is decided by the repository-controlled digest list, so a caller-written
 * receipt is refused however it is hashed or described. An accepted receipt is
 * then revalidated through the shared managed-image contract parser, which
 * holds it to the canonical NVIDIA repository for that candidate and an exact
 * image digest.
 */
export function readCandidateQualificationReceipt(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ManagedImageContractV1 {
  if (!isCandidateAgent(name)) {
    throw new CandidateQualificationError(`agent '${name}' is not a release candidate`);
  }
  const path = receiptPath(env);
  if (!path) {
    throw new CandidateQualificationError(
      `agent '${name}' requires a protected candidate qualification receipt`,
    );
  }
  const accepted = acceptedCandidateReceiptDigests(name);
  if (accepted.length === 0) {
    throw new CandidateQualificationError(
      `no qualified receipt is published for release candidate '${name}'`,
    );
  }
  const contents = readBoundedReceipt(path);
  const digest = createHash("sha256").update(contents, "utf8").digest("hex");
  if (!accepted.includes(digest)) {
    throw new CandidateQualificationError(
      "the receipt is not a published qualification for that candidate",
    );
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

/**
 * A candidate is exposed to selection only once its qualification receipt has
 * been read, digest-matched against the repository authority, and parsed. The
 * protected flag and a receipt path are necessary but never sufficient.
 */
export function isCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCandidateAgent(name) && isCandidateQualificationEnabled(name, env);
}

export function requireCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isCandidateAgent(name) && !isCandidateAgentSelectable(name, env)) {
    throw new Error(candidateAgentUnavailableMessage(name));
  }
}

export function requireCandidateQualificationEnabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  requireCandidateAgentSelectable(name, env);
  if (isCandidateAgent(name)) readCandidateQualificationReceipt(name, env);
}
