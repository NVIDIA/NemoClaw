// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MANAGED_IMAGE_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const MANAGED_IMAGE_SOURCE_REPOSITORY = "NVIDIA/NemoClaw" as const;

export type ManagedImagePlatform = (typeof MANAGED_IMAGE_PLATFORMS)[number];

export const SHIPPED_MANAGED_IMAGE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export const CANDIDATE_MANAGED_IMAGE_AGENTS = ["pi"] as const;

export const MANAGED_IMAGE_AGENTS = [
  ...SHIPPED_MANAGED_IMAGE_AGENTS,
  ...CANDIDATE_MANAGED_IMAGE_AGENTS,
] as const;

export type ShippedManagedImageAgent = (typeof SHIPPED_MANAGED_IMAGE_AGENTS)[number];
export type CandidateManagedImageAgent = (typeof CANDIDATE_MANAGED_IMAGE_AGENTS)[number];
export type ManagedImageAgent = (typeof MANAGED_IMAGE_AGENTS)[number];

export interface ManagedImageRuntimeIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly workdir: "/sandbox";
}

/**
 * Shipped images bake in these numeric sandbox identities. Candidate
 * qualification verifies the declared identity before activation. Runtime
 * providers consume this workload contract without adding agent switches to
 * central orchestration.
 */
export const MANAGED_IMAGE_RUNTIME_IDENTITIES = Object.freeze({
  openclaw: Object.freeze({ uid: 998, gid: 998, workdir: "/sandbox" }),
  hermes: Object.freeze({ uid: 998, gid: 999, workdir: "/sandbox" }),
  "langchain-deepagents-code": Object.freeze({ uid: 999, gid: 999, workdir: "/sandbox" }),
  pi: Object.freeze({ uid: 999, gid: 999, workdir: "/sandbox" }),
} as const satisfies Record<ManagedImageAgent, ManagedImageRuntimeIdentity>);

export function managedImageRuntimeIdentity(agent: ManagedImageAgent): ManagedImageRuntimeIdentity {
  return MANAGED_IMAGE_RUNTIME_IDENTITIES[agent];
}

export const MANAGED_IMAGE_REPOSITORIES = {
  openclaw: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
  pi: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
} as const satisfies Record<ManagedImageAgent, string>;

export type PublicManagedImageRepository = (typeof MANAGED_IMAGE_REPOSITORIES)[ManagedImageAgent];
export type ManagedImageDigest = `sha256:${string}`;
export type ManagedImageReference = `${PublicManagedImageRepository}@${ManagedImageDigest}`;
export type ManagedImagePublicationCohort = `ghrun-${number}-${number}`;

export interface ManagedImageSourceIdentity {
  readonly repository: typeof MANAGED_IMAGE_SOURCE_REPOSITORY;
  readonly revision: string;
  readonly release: string;
  readonly cohort: ManagedImagePublicationCohort;
}

/**
 * Immutable identity consumed by stock buildless onboarding for shipped
 * agents and by protected qualification for candidates.
 *
 * The validated cohort binds all shipped agent images to one publication.
 * Other publication evidence (mutable aliases and base-image provenance) stays
 * outside this runtime identity.
 */
export interface ManagedImageContractV1 {
  readonly contractVersion: typeof MANAGED_IMAGE_CONTRACT_VERSION;
  readonly agent: ManagedImageAgent;
  readonly platform: ManagedImagePlatform;
  readonly image: PublicManagedImageRepository;
  readonly digest: ManagedImageDigest;
  readonly reference: ManagedImageReference;
  readonly source: ManagedImageSourceIdentity;
  readonly startupProfileContractVersion: typeof MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION;
  readonly capabilityContractVersion: typeof MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION;
}

export type ManagedImageContractCatalog = Readonly<Record<string, unknown>>;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_PATTERN = /^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const COHORT_PATTERN = /^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;

export class ManagedImageContractError extends Error {
  constructor(message: string) {
    super(`Invalid managed image contract: ${message}`);
    this.name = "ManagedImageContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ManagedImageContractError(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ManagedImageContractError(`${field} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new ManagedImageContractError(`${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ManagedImageContractError(`${field} has an unsupported format`);
  }
  return value;
}

export function isShippedManagedImageAgent(value: string): value is ShippedManagedImageAgent {
  return (SHIPPED_MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isCandidateManagedImageAgent(value: string): value is CandidateManagedImageAgent {
  return (CANDIDATE_MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isManagedImageAgent(value: string): value is ManagedImageAgent {
  return (MANAGED_IMAGE_AGENTS as readonly string[]).includes(value);
}

export function isManagedImagePlatform(value: unknown): value is ManagedImagePlatform {
  return (
    typeof value === "string" && (MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(value)
  );
}

export function managedImagePlatformForNodeArchitecture(
  nodeArchitecture: string,
): ManagedImagePlatform | null {
  if (nodeArchitecture === "x64" || nodeArchitecture === "amd64") return "linux/amd64";
  if (nodeArchitecture === "arm64") return "linux/arm64";
  return null;
}

export function parseManagedImageContractV1(
  value: unknown,
  expectedAgent?: ManagedImageAgent,
  expectedPlatform?: ManagedImagePlatform,
): ManagedImageContractV1 {
  const contract = requireRecord(value, "contract");
  requireExactKeys(
    contract,
    [
      "agent",
      "capabilityContractVersion",
      "contractVersion",
      "digest",
      "image",
      "platform",
      "reference",
      "source",
      "startupProfileContractVersion",
    ],
    "contract",
  );

  requireLiteral(
    contract.contractVersion,
    MANAGED_IMAGE_CONTRACT_VERSION,
    "contract.contractVersion",
  );
  if (typeof contract.agent !== "string" || !isManagedImageAgent(contract.agent)) {
    throw new ManagedImageContractError("contract.agent is not a managed image agent");
  }
  const agent = contract.agent;
  if (expectedAgent !== undefined && agent !== expectedAgent) {
    throw new ManagedImageContractError(`contract.agent must be ${JSON.stringify(expectedAgent)}`);
  }

  if (!isManagedImagePlatform(contract.platform)) {
    throw new ManagedImageContractError(
      `contract.platform must be one of: ${MANAGED_IMAGE_PLATFORMS.join(", ")}`,
    );
  }
  const platform = contract.platform;
  if (expectedPlatform !== undefined && platform !== expectedPlatform) {
    throw new ManagedImageContractError(
      `contract.platform must be ${JSON.stringify(expectedPlatform)}`,
    );
  }
  const image = requireLiteral(contract.image, MANAGED_IMAGE_REPOSITORIES[agent], "contract.image");
  const digest = requirePattern(contract.digest, DIGEST_PATTERN, "contract.digest");
  const reference = requireLiteral(contract.reference, `${image}@${digest}`, "contract.reference");

  const source = requireRecord(contract.source, "contract.source");
  requireExactKeys(source, ["cohort", "release", "repository", "revision"], "contract.source");
  const sourceRepository = requireLiteral(
    source.repository,
    MANAGED_IMAGE_SOURCE_REPOSITORY,
    "contract.source.repository",
  );
  const sourceRevision = requirePattern(
    source.revision,
    REVISION_PATTERN,
    "contract.source.revision",
  );
  const sourceRelease = requirePattern(source.release, RELEASE_PATTERN, "contract.source.release");
  const sourceCohort = requirePattern(source.cohort, COHORT_PATTERN, "contract.source.cohort");
  const startupProfileContractVersion = requireLiteral(
    contract.startupProfileContractVersion,
    MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    "contract.startupProfileContractVersion",
  );
  const capabilityContractVersion = requireLiteral(
    contract.capabilityContractVersion,
    MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    "contract.capabilityContractVersion",
  );

  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest: digest as ManagedImageDigest,
    reference: reference as ManagedImageReference,
    source: {
      repository: sourceRepository,
      revision: sourceRevision,
      release: sourceRelease,
      cohort: sourceCohort as ManagedImagePublicationCohort,
    },
    startupProfileContractVersion,
    capabilityContractVersion,
  };
}
