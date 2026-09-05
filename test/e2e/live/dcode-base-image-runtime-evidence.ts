// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { readSandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/label-codec.ts";
import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types.ts";
import {
  DCODE_BASE_IMAGE_TARGET_PLATFORM,
  type DcodeBaseImageContract,
  parseDcodeBaseImageContract,
} from "../../../tools/e2e/dcode-base-image-contract.mts";
import {
  DCODE_BASE_IMAGE_ENV,
  requireDcodeBaseImageReference,
} from "../fixtures/dcode-base-image.ts";
import { readRegistrySandboxEntry } from "../fixtures/phases/index.ts";

export const DCODE_BASE_IMAGE_TARGET_ID = "ubuntu-repo-cloud-langchain-deepagents-code";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export interface DcodeBaseImageRuntimeEvidence {
  contractReference: string;
  digest: string;
  image: string;
  imageId: string;
  platform: typeof DCODE_BASE_IMAGE_TARGET_PLATFORM;
  reference: string;
  sandboxImage: string;
  source: "override";
  sourceRevision: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function expectedCandidateSha(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ?? "";
  const githubActions = environment.GITHUB_ACTIONS === "true";
  const candidateSha = configured || (githubActions ? (environment.GITHUB_SHA?.trim() ?? "") : "");
  if (!candidateSha && !githubActions) return undefined;
  if (!REVISION_PATTERN.test(candidateSha)) {
    throw new Error("Deep Agents Code expected candidate SHA is invalid");
  }
  return candidateSha;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
}

export function parseDcodeBaseImagePublicationEvidence(
  value: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): DcodeBaseImageContract {
  const evidence = record(value, "Deep Agents Code base evidence");
  exactKeys(
    evidence,
    ["base", "candidateSha", "contractVersion"],
    "Deep Agents Code base evidence",
  );
  if (evidence.contractVersion !== 1) {
    throw new Error("Deep Agents Code base evidence contract version must be 1");
  }
  if (typeof evidence.candidateSha !== "string" || !REVISION_PATTERN.test(evidence.candidateSha)) {
    throw new Error("Deep Agents Code base evidence candidate SHA is invalid");
  }
  const expected = expectedCandidateSha(environment);
  if (expected && evidence.candidateSha !== expected) {
    throw new Error(
      "Deep Agents Code base evidence candidate SHA does not match the selected candidate",
    );
  }
  const contract = parseDcodeBaseImageContract(evidence.base);
  if (
    requireDcodeBaseImageReference(environment) !==
    contract.platformReferences[DCODE_BASE_IMAGE_TARGET_PLATFORM]
  ) {
    throw new Error(
      `Deep Agents Code onboarding reference does not match the published ${DCODE_BASE_IMAGE_TARGET_PLATFORM} base contract`,
    );
  }
  return contract;
}

export function dcodeBaseImageReferenceForContract(contract: DcodeBaseImageContract): string {
  return contract.platformReferences[DCODE_BASE_IMAGE_TARGET_PLATFORM];
}

function requireDcodeSourceRevision(metadata: SandboxBaseImageResolutionMetadata): string {
  if (!metadata.sourceRevision || !REVISION_PATTERN.test(metadata.sourceRevision)) {
    throw new Error(
      `Deep Agents Code sandbox image does not match the published ${DCODE_BASE_IMAGE_TARGET_PLATFORM} base-image contract (mismatched fields: source revision)`,
    );
  }
  return metadata.sourceRevision;
}

export function loadDcodeBaseImagePublicationEvidence(
  targetId: string,
  evidencePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): DcodeBaseImageContract | undefined {
  if (targetId !== DCODE_BASE_IMAGE_TARGET_ID) return undefined;
  const workloadSource = environment.E2E_WORKLOAD_SOURCE?.trim() ?? "";
  if (workloadSource === "local-dockerfile") {
    if ((environment[DCODE_BASE_IMAGE_ENV]?.trim() ?? "") || fs.existsSync(evidencePath)) {
      throw new Error(
        "Deep Agents Code local-Dockerfile E2E cannot consume published base-image authority",
      );
    }
    return undefined;
  }
  if (workloadSource !== "" && workloadSource !== "managed-image") {
    throw new Error("Deep Agents Code E2E workload source is invalid");
  }
  if (!fs.existsSync(evidencePath)) {
    requireDcodeBaseImageReference(environment);
    if (environment.GITHUB_ACTIONS === "true") {
      throw new Error("Deep Agents Code GitHub Actions run is missing published base evidence");
    }
    return undefined;
  }
  return parseDcodeBaseImagePublicationEvidence(
    JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown,
    environment,
  );
}

export function verifyDcodeBaseImageRuntimeEvidence(
  contract: DcodeBaseImageContract,
  sandboxImage: string,
  metadata: SandboxBaseImageResolutionMetadata | null,
): DcodeBaseImageRuntimeEvidence {
  if (!sandboxImage) {
    throw new Error("Deep Agents Code registry entry is missing its completed sandbox image");
  }
  if (!metadata) {
    throw new Error("Deep Agents Code sandbox image is missing base resolution metadata");
  }
  if (`${metadata.os}/${metadata.architecture}` !== DCODE_BASE_IMAGE_TARGET_PLATFORM) {
    throw new Error(
      `Deep Agents Code sandbox image did not use the published ${DCODE_BASE_IMAGE_TARGET_PLATFORM} base digest`,
    );
  }
  const expectedDigest = contract.platformDigests[DCODE_BASE_IMAGE_TARGET_PLATFORM];
  const expectedReference = dcodeBaseImageReferenceForContract(contract);
  const sourceRevision = requireDcodeSourceRevision(metadata);
  const mismatchedFields = [
    metadata.schema !== 1 ? "schema" : null,
    metadata.imageName !== contract.image ? "image" : null,
    metadata.source !== "override" ? "source" : null,
    metadata.pinnedRemoteRef !== undefined ? "pinned reference" : null,
    metadata.digest !== expectedDigest ? "digest" : null,
    metadata.ref !== expectedReference ? "reference" : null,
    metadata.ref !== `${metadata.imageName}@${metadata.digest}` ? "reference binding" : null,
    sourceRevision !== contract.sourceRevision ? "source revision" : null,
  ].filter((field): field is string => field !== null);
  if (mismatchedFields.length > 0) {
    throw new Error(
      `Deep Agents Code sandbox image does not match the published ${DCODE_BASE_IMAGE_TARGET_PLATFORM} base-image contract (mismatched fields: ${mismatchedFields.join(", ")})`,
    );
  }
  return {
    contractReference: contract.reference,
    digest: expectedDigest,
    image: contract.image,
    imageId: metadata.imageId,
    platform: DCODE_BASE_IMAGE_TARGET_PLATFORM,
    reference: expectedReference,
    sandboxImage,
    source: "override",
    sourceRevision,
  };
}

export function captureDcodeBaseImageRuntimeEvidence(
  contract: DcodeBaseImageContract,
  sandboxName: string,
): DcodeBaseImageRuntimeEvidence {
  const entry = readRegistrySandboxEntry(sandboxName);
  const sandboxImage = typeof entry.imageTag === "string" ? entry.imageTag.trim() : "";
  return verifyDcodeBaseImageRuntimeEvidence(
    contract,
    sandboxImage,
    readSandboxBaseImageResolutionMetadata(sandboxImage),
  );
}
