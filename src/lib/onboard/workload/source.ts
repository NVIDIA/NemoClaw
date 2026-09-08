// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isCandidateManagedImageAgent,
  isManagedImageAgent,
  isManagedImagePlatform,
  isShippedManagedImageAgent,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  parseManagedImageContractV1,
} from "../managed-image/contract";

export type ManagedImageSelectionPolicy = "prefer-managed" | "require-managed";

/**
 * Capabilities are advertised by the selected OpenShell compute driver.
 * `driverName` is intentionally opaque: Docker, Podman, MXC, and future
 * drivers all negotiate the same runtime contract.
 */
export interface SandboxWorkloadRuntimeCapabilities {
  readonly driverName: string;
  /**
   * Driver-owned selection policy. A buildless driver requires a managed image.
   * A Docker-compatible driver may retain the legacy Dockerfile build.
   */
  readonly managedImageSelectionPolicy: ManagedImageSelectionPolicy;
  /** Whether this driver can consume NemoClaw's legacy local Dockerfile build. */
  readonly legacyDockerfileBuilds: boolean;
  readonly managedImages: {
    readonly exactDigestReferences: boolean;
    readonly platforms: readonly ManagedImagePlatform[];
    readonly startupProfileContractVersions: readonly number[];
    readonly capabilityContractVersions: readonly number[];
  } | null;
}

export type LegacyDockerfileReason =
  | "custom-dockerfile"
  | "agent-not-managed"
  | "runtime-unsupported"
  | "contract-unavailable";

export interface LegacyDockerfileWorkloadSource {
  readonly kind: "legacy-dockerfile";
  readonly dockerfilePath: string;
  readonly reason: LegacyDockerfileReason;
}

export interface ManagedImageWorkloadSource {
  readonly kind: "managed-image";
  readonly reference: ManagedImageContractV1["reference"];
  readonly contract: ManagedImageContractV1;
}

export type SandboxWorkloadSource = LegacyDockerfileWorkloadSource | ManagedImageWorkloadSource;

export interface ResolveSandboxWorkloadSourceOptions {
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath?: string | null;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
  readonly catalog: ManagedImageContractCatalog;
  readonly policy?: ManagedImageSelectionPolicy;
  readonly candidateAgentsEnabled?: boolean;
}

export class SandboxWorkloadSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxWorkloadSourceError";
  }
}

function requireDockerfilePath(path: string, reason: LegacyDockerfileReason): string {
  if (path.trim() === "") {
    throw new SandboxWorkloadSourceError(
      `Cannot use the legacy Dockerfile workload for ${reason}: no Dockerfile path was supplied.`,
    );
  }
  return path;
}

function legacySource(
  options: ResolveSandboxWorkloadSourceOptions,
  reason: LegacyDockerfileReason,
): LegacyDockerfileWorkloadSource {
  if (isCandidateManagedImageAgent(options.agentName)) {
    throw new SandboxWorkloadSourceError(
      `Agent '${options.agentName}' is a release candidate and must use its exact managed image digest; the legacy Dockerfile workload is not accepted for ${reason}.`,
    );
  }
  if (!options.runtime.legacyDockerfileBuilds) {
    throw new SandboxWorkloadSourceError(
      `Driver '${options.runtime.driverName}' cannot use the legacy Dockerfile workload for ${reason}.`,
    );
  }
  const selectedPath =
    reason === "custom-dockerfile"
      ? (options.customDockerfilePath ?? "")
      : options.legacyDockerfilePath;
  return {
    kind: "legacy-dockerfile",
    dockerfilePath: requireDockerfilePath(selectedPath, reason),
    reason,
  };
}

function unavailableSource(
  options: ResolveSandboxWorkloadSourceOptions,
  reason: Exclude<LegacyDockerfileReason, "custom-dockerfile">,
  detail: string,
): LegacyDockerfileWorkloadSource {
  if (
    isCandidateManagedImageAgent(options.agentName) ||
    (options.policy ?? options.runtime.managedImageSelectionPolicy) === "require-managed"
  ) {
    throw new SandboxWorkloadSourceError(
      `Managed image workload is required for '${options.agentName}', but ${detail}.`,
    );
  }
  return legacySource(options, reason);
}

export function managedImageRuntimeSupportError(
  runtime: SandboxWorkloadRuntimeCapabilities,
): string | null {
  const capabilities = runtime.managedImages;
  if (capabilities === null)
    return `driver '${runtime.driverName}' does not advertise managed images`;
  if (!capabilities.exactDigestReferences) {
    return `driver '${runtime.driverName}' does not support exact-digest image references`;
  }
  if (capabilities.platforms.length !== 1 || !isManagedImagePlatform(capabilities.platforms[0])) {
    return `driver '${runtime.driverName}' does not identify exactly one supported host managed-image platform`;
  }
  if (
    !capabilities.startupProfileContractVersions.includes(
      MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    )
  ) {
    return `driver '${runtime.driverName}' does not support startup profile contract v${MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION}`;
  }
  if (
    !capabilities.capabilityContractVersions.includes(MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION)
  ) {
    return `driver '${runtime.driverName}' does not support capability contract v${MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION}`;
  }
  return null;
}

export function managedImageRuntimePlatform(
  runtime: SandboxWorkloadRuntimeCapabilities,
): ManagedImagePlatform | null {
  return managedImageRuntimeSupportError(runtime) === null
    ? (runtime.managedImages?.platforms[0] ?? null)
    : null;
}

export function resolveSandboxWorkloadSource(
  options: ResolveSandboxWorkloadSourceOptions,
): SandboxWorkloadSource {
  if (
    isCandidateManagedImageAgent(options.agentName) &&
    options.customDockerfilePath !== undefined &&
    options.customDockerfilePath !== null
  ) {
    throw new SandboxWorkloadSourceError(
      `Agent '${options.agentName}' is a release candidate and must use its exact managed image digest; a custom Dockerfile is not accepted.`,
    );
  }

  if (options.customDockerfilePath !== undefined && options.customDockerfilePath !== null) {
    return legacySource(options, "custom-dockerfile");
  }

  const agentName = options.agentName;
  if (!isManagedImageAgent(agentName)) {
    return unavailableSource(
      options,
      "agent-not-managed",
      "the selected agent is not a shipped managed agent",
    );
  }
  if (!isShippedManagedImageAgent(agentName) && options.candidateAgentsEnabled !== true) {
    return unavailableSource(
      options,
      "agent-not-managed",
      "the selected agent is a release candidate and candidate selection is disabled",
    );
  }

  const runtimeSupportError = managedImageRuntimeSupportError(options.runtime);
  if (runtimeSupportError !== null) {
    return unavailableSource(options, "runtime-unsupported", runtimeSupportError);
  }

  const candidate = options.catalog[agentName];
  if (candidate === undefined) {
    return unavailableSource(
      options,
      "contract-unavailable",
      "the catalog has no exact contract for that agent",
    );
  }

  const expectedPlatform = managedImageRuntimePlatform(options.runtime);
  if (expectedPlatform === null) {
    throw new SandboxWorkloadSourceError(
      `Driver '${options.runtime.driverName}' has no unambiguous managed-image host platform.`,
    );
  }

  try {
    const contract = parseManagedImageContractV1(candidate, agentName, expectedPlatform);
    return {
      kind: "managed-image",
      reference: contract.reference,
      contract,
    };
  } catch (error) {
    throw new SandboxWorkloadSourceError(
      `Managed image contract for '${agentName}' failed closed validation.`,
      { cause: error },
    );
  }
}
