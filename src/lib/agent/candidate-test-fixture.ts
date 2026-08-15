// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CandidateManagedImageAgent,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  type ManagedImagePlatform,
} from "../onboard/managed-image/contract";
import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_SHA256_ENV,
} from "./candidate";

export function candidateQualificationContract(
  agent: CandidateManagedImageAgent = "pi",
  platform: ManagedImagePlatform = MANAGED_IMAGE_PLATFORMS[0],
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${"7a".repeat(32)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: "d".repeat(40),
      release: "v0.0.100",
      cohort: "ghrun-7927-1",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

/**
 * Write a qualification receipt and return the environment that authorises the
 * candidate agent. Tests use this instead of asserting the protected flag on its
 * own, because the flag alone must never activate a withheld agent.
 */
export function candidateQualificationEnvironment(
  options: {
    readonly agent?: CandidateManagedImageAgent;
    readonly contract?: ManagedImageContractV1;
    readonly corruptDigest?: boolean;
  } = {},
): NodeJS.ProcessEnv & { readonly receiptPath: string } {
  const agent = options.agent ?? "pi";
  const contract = options.contract ?? candidateQualificationContract(agent);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-candidate-receipt-"));
  const receiptPath = path.join(directory, "candidate-qualification.json");
  const contents = JSON.stringify(contract);
  fs.writeFileSync(receiptPath, contents, { mode: 0o600 });
  const sha256 = options.corruptDigest
    ? "0".repeat(64)
    : createHash("sha256").update(contents, "utf8").digest("hex");
  return {
    [CANDIDATE_AGENT_FEATURE_ENV]: "1",
    [CANDIDATE_QUALIFICATION_RECEIPT_ENV]: receiptPath,
    [CANDIDATE_QUALIFICATION_RECEIPT_SHA256_ENV]: sha256,
    receiptPath,
  };
}
