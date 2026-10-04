// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShippedManagedImageAgent } from "../../src/lib/onboard/managed-image/contract.ts";

const BASE_REPOSITORIES: Readonly<Record<ShippedManagedImageAgent, string>> = Object.freeze({
  openclaw: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
});

export const PROTECTED_MANAGED_IMAGE_AGENTS = Object.freeze(
  Object.keys(BASE_REPOSITORIES),
) as readonly ShippedManagedImageAgent[];

export const PROTECTED_MANAGED_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID = "managed-image-multiarch-startup" as const;
export const PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH =
  "ci/protected-managed-image-multiarch-activation-v1.json" as const;

export type ProtectedManagedImagePlatform = (typeof PROTECTED_MANAGED_IMAGE_PLATFORMS)[number];

export type ProtectedManagedImageContract = {
  readonly agent: ShippedManagedImageAgent;
  readonly baseReference: string;
  readonly digest: string;
  readonly localContentId: string;
  readonly platform: ProtectedManagedImagePlatform;
  readonly reference: string;
};

export type ProtectedManagedImageActivation = {
  readonly agents: readonly ShippedManagedImageAgent[];
  readonly contractVersion: 1;
  readonly jobId: typeof PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID;
  readonly platforms: readonly ProtectedManagedImagePlatform[];
};

export type ProtectedManagedImageDirectRun = Pick<
  ProtectedManagedImageContract,
  "agent" | "digest" | "platform" | "reference"
>;

export type ProtectedManagedImageEvidence = {
  readonly baseSha: string;
  readonly cohort: string;
  readonly contracts: readonly ProtectedManagedImageContract[];
  readonly contractSha256: string;
  readonly directRuns: readonly ProtectedManagedImageDirectRun[];
  readonly headSha: string;
  readonly kind: "nemoclaw-protected-managed-image-multiarch-v1";
  readonly platform: ProtectedManagedImagePlatform;
  readonly run: {
    readonly attempt: number;
    readonly id: number;
  };
  readonly workflowSha: string;
};

export type ProtectedManagedImageEvidenceIdentity = Pick<
  ProtectedManagedImageEvidence,
  "baseSha" | "cohort" | "headSha" | "platform" | "workflowSha"
> & {
  readonly runAttempt: number;
  readonly runId: number;
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const PROTECTED_MANAGED_IMAGE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const PROTECTED_MANAGED_IMAGE_COHORT_PATTERN =
  /^protected-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protected managed-image contract entry must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [
    "agent",
    "baseReference",
    "digest",
    "localContentId",
    "platform",
    "reference",
  ].sort();
  if (actual.some((key, index) => key !== expected[index]) || actual.length !== expected.length) {
    throw new Error("protected managed-image contract entry has unexpected fields");
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function parseEntry(
  value: unknown,
  expectedPlatform: ProtectedManagedImagePlatform,
): ProtectedManagedImageContract {
  const entry = record(value);
  exactKeys(entry);
  if (
    typeof entry.agent !== "string" ||
    !PROTECTED_MANAGED_IMAGE_AGENTS.includes(entry.agent as ShippedManagedImageAgent)
  ) {
    throw new Error("protected managed-image contract entry has an invalid agent");
  }
  if (entry.platform !== expectedPlatform) {
    throw new Error("protected managed-image contract entry has the wrong platform");
  }
  if (
    typeof entry.digest !== "string" ||
    !DIGEST_PATTERN.test(entry.digest) ||
    typeof entry.localContentId !== "string" ||
    !DIGEST_PATTERN.test(entry.localContentId)
  ) {
    throw new Error("protected managed-image contract entry has an invalid content identity");
  }
  const expectedRepository = `localhost:5000/nemoclaw-managed-protected/${entry.agent}`;
  if (entry.reference !== `${expectedRepository}@${entry.digest}`) {
    throw new Error("protected managed-image contract entry is not the exact agent digest");
  }
  const basePrefix = `${BASE_REPOSITORIES[entry.agent as ShippedManagedImageAgent]}@`;
  if (
    typeof entry.baseReference !== "string" ||
    !entry.baseReference.startsWith(basePrefix) ||
    !DIGEST_PATTERN.test(entry.baseReference.slice(basePrefix.length))
  ) {
    throw new Error("protected managed-image contract entry has an invalid base reference");
  }
  return {
    agent: entry.agent as ShippedManagedImageAgent,
    baseReference: entry.baseReference,
    digest: entry.digest,
    localContentId: entry.localContentId,
    platform: expectedPlatform,
    reference: entry.reference,
  };
}

export function parseProtectedManagedImageContracts(
  value: unknown,
  expectedPlatform: ProtectedManagedImagePlatform,
): ProtectedManagedImageContract[] {
  if (!Array.isArray(value) || value.length !== PROTECTED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error("protected managed-image contract must contain exactly all shipped agents");
  }
  const contracts = value.map((entry) => parseEntry(entry, expectedPlatform));
  const actualAgents = contracts.map(({ agent }) => agent).sort();
  const expectedAgents = [...PROTECTED_MANAGED_IMAGE_AGENTS].sort();
  if (actualAgents.some((agent, index) => agent !== expectedAgents[index])) {
    throw new Error("protected managed-image contract must contain each shipped agent once");
  }
  if (
    new Set(contracts.map(({ reference }) => reference)).size !== contracts.length ||
    new Set(contracts.map(({ localContentId }) => localContentId)).size !== contracts.length
  ) {
    throw new Error("protected managed-image contract must contain unique immutable images");
  }
  return contracts;
}

export function parseProtectedManagedImageActivation(
  value: unknown,
): ProtectedManagedImageActivation {
  const activation = record(value);
  requireExactKeys(
    activation,
    ["agents", "contractVersion", "jobId", "platforms"],
    "protected managed-image activation",
  );
  if (
    activation.contractVersion !== 1 ||
    activation.jobId !== PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID ||
    JSON.stringify(activation.agents) !== JSON.stringify(PROTECTED_MANAGED_IMAGE_AGENTS) ||
    JSON.stringify(activation.platforms) !== JSON.stringify(PROTECTED_MANAGED_IMAGE_PLATFORMS)
  ) {
    throw new Error("protected managed-image activation contract is invalid");
  }
  return {
    agents: PROTECTED_MANAGED_IMAGE_AGENTS,
    contractVersion: 1,
    jobId: PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
    platforms: PROTECTED_MANAGED_IMAGE_PLATFORMS,
  };
}

export function parseProtectedManagedImageEvidence(
  value: unknown,
  expected: ProtectedManagedImageEvidenceIdentity,
): ProtectedManagedImageEvidence {
  const evidence = record(value);
  requireExactKeys(
    evidence,
    [
      "baseSha",
      "cohort",
      "contracts",
      "contractSha256",
      "directRuns",
      "headSha",
      "kind",
      "platform",
      "run",
      "workflowSha",
    ],
    "protected managed-image evidence",
  );
  if (
    evidence.kind !== "nemoclaw-protected-managed-image-multiarch-v1" ||
    evidence.headSha !== expected.headSha ||
    evidence.baseSha !== expected.baseSha ||
    evidence.workflowSha !== expected.workflowSha ||
    evidence.platform !== expected.platform ||
    evidence.cohort !== expected.cohort ||
    typeof evidence.headSha !== "string" ||
    typeof evidence.baseSha !== "string" ||
    typeof evidence.workflowSha !== "string" ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(evidence.headSha) ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(evidence.baseSha) ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(evidence.workflowSha) ||
    typeof evidence.cohort !== "string" ||
    !PROTECTED_MANAGED_IMAGE_COHORT_PATTERN.test(evidence.cohort) ||
    typeof evidence.contractSha256 !== "string" ||
    !DIGEST_PATTERN.test(evidence.contractSha256)
  ) {
    throw new Error("protected managed-image evidence identity is invalid");
  }

  const run = record(evidence.run);
  requireExactKeys(run, ["attempt", "id"], "protected managed-image evidence run");
  if (
    run.id !== expected.runId ||
    run.attempt !== expected.runAttempt ||
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.attempt) ||
    Number(run.id) < 1 ||
    Number(run.attempt) < 1
  ) {
    throw new Error("protected managed-image evidence run identity is invalid");
  }

  const contracts = parseProtectedManagedImageContracts(evidence.contracts, expected.platform);
  if (!Array.isArray(evidence.directRuns) || evidence.directRuns.length !== contracts.length) {
    throw new Error("protected managed-image evidence must directly run every contract");
  }
  const contractByAgent = new Map(contracts.map((contract) => [contract.agent, contract]));
  const seenAgents = new Set<ShippedManagedImageAgent>();
  const directRuns = evidence.directRuns.map((value): ProtectedManagedImageDirectRun => {
    const directRun = record(value);
    requireExactKeys(
      directRun,
      ["agent", "digest", "platform", "reference"],
      "protected managed-image direct run",
    );
    const contract =
      typeof directRun.agent === "string"
        ? contractByAgent.get(directRun.agent as ShippedManagedImageAgent)
        : undefined;
    if (
      !contract ||
      seenAgents.has(contract.agent) ||
      directRun.digest !== contract.digest ||
      directRun.platform !== contract.platform ||
      directRun.reference !== contract.reference
    ) {
      throw new Error("protected managed-image direct run does not match its exact contract");
    }
    seenAgents.add(contract.agent);
    return {
      agent: contract.agent,
      digest: contract.digest,
      platform: contract.platform,
      reference: contract.reference,
    };
  });
  if (seenAgents.size !== PROTECTED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error("protected managed-image evidence must directly run every shipped agent");
  }

  return {
    baseSha: evidence.baseSha,
    cohort: evidence.cohort,
    contracts,
    contractSha256: evidence.contractSha256,
    directRuns,
    headSha: evidence.headSha,
    kind: "nemoclaw-protected-managed-image-multiarch-v1",
    platform: expected.platform,
    run: { attempt: expected.runAttempt, id: expected.runId },
    workflowSha: evidence.workflowSha,
  };
}
