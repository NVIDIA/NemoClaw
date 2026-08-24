// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ManagedImageCatalogUnavailableError,
  normalizeManagedImageRelease,
  resolveManagedImageCatalogFromGhcr,
} from "../managed-image/catalog";
import {
  isCandidateManagedImageAgent,
  isManagedImageAgent,
  isShippedManagedImageAgent,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../managed-image/contract";
import {
  type ManagedImageSelectionPolicy,
  managedImageRuntimePlatform,
  managedImageRuntimeSupportError,
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
  type SandboxWorkloadSource,
} from "./source";

type ResolveManagedImageCatalog = (options: {
  readonly release: string;
  readonly platform: ManagedImagePlatform;
  readonly revision?: string;
}) => Promise<ManagedImageContractCatalog>;

export interface PrepareSandboxWorkloadSourceInput {
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath?: string | null;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
  readonly version: string;
  readonly policy?: ManagedImageSelectionPolicy;
  readonly catalogPath?: string | null;
  readonly expectedCatalogRevision?: string | null;
  readonly catalogRevision?: string | null;
  /** Contract from the repository-accepted candidate qualification receipt. */
  readonly acceptedCandidateContract?: ManagedImageContractV1 | null;
}

export function liveE2eManagedImageRevision(environment: NodeJS.ProcessEnv): string | null {
  if (environment.GITHUB_ACTIONS !== "true") return null;
  const revision = environment.E2E_MANAGED_IMAGE_REVISION?.trim();
  return revision ? revision : null;
}

export interface LiveE2eManagedImageCatalog {
  readonly path: string;
  readonly revision: string;
}

/** Select the trusted PR catalog only for an exact live E2E candidate. */
export function liveE2eManagedImageCatalog(
  environment: NodeJS.ProcessEnv,
): LiveE2eManagedImageCatalog | null {
  if (environment.GITHUB_ACTIONS !== "true" || environment.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    return null;
  }
  const configuredPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG?.trim();
  const workspace = environment.GITHUB_WORKSPACE?.trim();
  const catalogPath =
    configuredPath ||
    (workspace ? path.join(workspace, "dist", "e2e-managed-image-catalog.json") : "");
  if (!catalogPath) return null;
  try {
    fs.lstatSync(catalogPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog path could not be inspected",
      { cause: error },
    );
  }
  const revision = environment.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog requires an exact candidate revision",
    );
  }
  return { path: catalogPath, revision };
}

function readExactManagedImageCatalog(catalogPath: string): ManagedImageContractCatalog {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(catalogPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const metadata = fs.fstatSync(descriptor);
    const pathMetadata = fs.lstatSync(catalogPath);
    if (
      pathMetadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.size < 2 ||
      metadata.size > 64 * 1024
    ) {
      throw new SandboxWorkloadPreparationError(
        "managed image catalog file must be a bounded regular file",
      );
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SandboxWorkloadPreparationError(
        "managed image catalog file must contain an object",
      );
    }
    return parsed as ManagedImageContractCatalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SandboxWorkloadPreparationError(
        "managed image catalog file must be a bounded regular file",
      );
    }
    if (error instanceof SandboxWorkloadPreparationError) throw error;
    throw new SandboxWorkloadPreparationError("managed image catalog file could not be read", {
      cause: error,
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export interface PrepareSandboxWorkloadSourceDependencies {
  readonly resolveCatalog?: ResolveManagedImageCatalog;
}

export interface PreparedSandboxWorkloadSource {
  readonly source: SandboxWorkloadSource;
  readonly release: string | null;
  /**
   * A non-secret operator diagnostic for an allowed legacy fallback. Selection
   * errors remain exceptions when managed images are required.
   */
  readonly fallbackDiagnostic: string | null;
}

export class SandboxWorkloadPreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Sandbox workload preparation failed: ${message}`, options);
    this.name = "SandboxWorkloadPreparationError";
  }
}

function diagnostic(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "managed image catalog resolution failed";
}

function unavailableResult(
  input: PrepareSandboxWorkloadSourceInput,
  message: string,
): PreparedSandboxWorkloadSource {
  if ((input.policy ?? input.runtime.managedImageSelectionPolicy) === "require-managed") {
    throw new SandboxWorkloadPreparationError(message);
  }
  const source = resolveSandboxWorkloadSource({
    agentName: input.agentName,
    legacyDockerfilePath: input.legacyDockerfilePath,
    customDockerfilePath: input.customDockerfilePath,
    runtime: input.runtime,
    catalog: {},
    policy: input.policy ?? input.runtime.managedImageSelectionPolicy,
    candidateAgentsEnabled: input.acceptedCandidateContract != null,
  });
  return {
    source,
    release: null,
    fallbackDiagnostic: message,
  };
}

function requireCompleteManagedImageCatalog(
  catalog: ManagedImageContractCatalog,
  expectedRelease: string,
  expectedPlatform: ManagedImagePlatform,
  expectedRevision: string | null,
): { readonly release: string; readonly revision: string } {
  let cohortRevision: string | null = null;
  let cohortRelease: string | null = null;
  let publicationCohort: string | null = null;
  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    const candidate = catalog[agent];
    if (candidate === undefined) {
      throw new SandboxWorkloadPreparationError(
        `managed image catalog is incomplete; '${agent}' is missing`,
      );
    }
    try {
      const contract = parseManagedImageContractV1(candidate, agent, expectedPlatform);
      if (expectedRevision === null && contract.source.release !== expectedRelease) {
        throw new SandboxWorkloadPreparationError(
          `managed image catalog contract for '${agent}' belongs to '${contract.source.release}', not '${expectedRelease}'`,
        );
      }
      cohortRelease ??= contract.source.release;
      if (contract.source.release !== cohortRelease) {
        throw new SandboxWorkloadPreparationError(
          "managed image catalog does not identify one all-agent release",
        );
      }
      cohortRevision ??= contract.source.revision;
      if (contract.source.revision !== cohortRevision) {
        throw new SandboxWorkloadPreparationError(
          "managed image catalog does not identify one all-agent source revision",
        );
      }
      publicationCohort ??= contract.source.cohort;
      if (contract.source.cohort !== publicationCohort) {
        throw new SandboxWorkloadPreparationError(
          "managed image catalog does not identify one all-agent publication cohort",
        );
      }
    } catch (error) {
      if (error instanceof SandboxWorkloadPreparationError) throw error;
      throw new SandboxWorkloadPreparationError(
        `managed image catalog contract for '${agent}' failed closed validation`,
        { cause: error },
      );
    }
  }
  if (expectedRevision !== null && cohortRevision !== expectedRevision) {
    throw new SandboxWorkloadPreparationError(
      "managed image catalog source revision does not match the live E2E candidate revision",
    );
  }
  return { release: cohortRelease!, revision: cohortRevision! };
}

function requireCandidateManagedImageCatalog(
  catalog: ManagedImageContractCatalog,
  agent: string,
  expectedPlatform: ManagedImagePlatform,
  acceptedContract: ManagedImageContractV1,
): void {
  const candidate = catalog[agent];
  if (candidate === undefined) {
    throw new SandboxWorkloadPreparationError(
      `managed image catalog is incomplete; '${agent}' is missing`,
    );
  }
  if (!isManagedImageAgent(agent)) {
    throw new SandboxWorkloadPreparationError(`'${agent}' is not a managed-image agent`);
  }
  let contract: ReturnType<typeof parseManagedImageContractV1>;
  let accepted: ReturnType<typeof parseManagedImageContractV1>;
  try {
    contract = parseManagedImageContractV1(candidate, agent, expectedPlatform);
    accepted = parseManagedImageContractV1(acceptedContract, agent, expectedPlatform);
  } catch (error) {
    throw new SandboxWorkloadPreparationError(
      `managed image catalog contract for '${agent}' failed closed validation`,
      { cause: error },
    );
  }
  if (isShippedManagedImageAgent(contract.agent)) {
    throw new SandboxWorkloadPreparationError(
      `'${contract.agent}' is already shipped and cannot resolve a candidate contract`,
    );
  }
  if (!isDeepStrictEqual(contract, accepted)) {
    throw new SandboxWorkloadPreparationError(
      `managed image catalog contract for '${agent}' does not match the accepted qualification receipt`,
    );
  }
}

/**
 * Resolve a stock workload to an immutable managed image without fetching a
 * catalog for custom, unshipped, or incapable runtime paths.
 *
 * The public catalog is resolved as one all-agent unit. The resolver rejects a
 * release catalog that omits Hermes or LangChain Deep Agents Code.
 */
export async function prepareSandboxWorkloadSource(
  input: PrepareSandboxWorkloadSourceInput,
  dependencies: PrepareSandboxWorkloadSourceDependencies = {},
): Promise<PreparedSandboxWorkloadSource> {
  const policy = input.policy ?? input.runtime.managedImageSelectionPolicy;
  const acceptedCandidateContract = isCandidateManagedImageAgent(input.agentName)
    ? (input.acceptedCandidateContract ?? null)
    : null;
  const candidateSelection = acceptedCandidateContract !== null;
  const cannotSelectManaged =
    input.customDockerfilePath != null ||
    !isManagedImageAgent(input.agentName) ||
    (!isShippedManagedImageAgent(input.agentName) && !candidateSelection) ||
    managedImageRuntimeSupportError(input.runtime) !== null;
  if (cannotSelectManaged) {
    return {
      source: resolveSandboxWorkloadSource({
        agentName: input.agentName,
        legacyDockerfilePath: input.legacyDockerfilePath,
        customDockerfilePath: input.customDockerfilePath,
        runtime: input.runtime,
        catalog: {},
        policy,
        candidateAgentsEnabled: candidateSelection,
      }),
      release: null,
      fallbackDiagnostic: null,
    };
  }

  if (candidateSelection && !input.catalogPath) {
    throw new SandboxWorkloadPreparationError(
      `'${input.agentName}' is a release candidate and requires an exact managed image catalog file`,
    );
  }

  let release: string;
  try {
    release = normalizeManagedImageRelease(input.version);
  } catch (error) {
    throw new SandboxWorkloadPreparationError(
      `managed image release for CLI version '${input.version}' failed validation`,
      { cause: error },
    );
  }

  let catalog: ManagedImageContractCatalog;
  const platform = managedImageRuntimePlatform(input.runtime);
  if (platform === null) {
    throw new SandboxWorkloadPreparationError(
      `driver '${input.runtime.driverName}' has no unambiguous managed-image host platform`,
    );
  }
  try {
    catalog = input.catalogPath
      ? readExactManagedImageCatalog(input.catalogPath)
      : await (
          dependencies.resolveCatalog ?? ((options) => resolveManagedImageCatalogFromGhcr(options))
        )({
          release,
          platform,
          ...(input.catalogRevision ? { revision: input.catalogRevision } : {}),
        });
  } catch (error) {
    if (!(error instanceof ManagedImageCatalogUnavailableError)) {
      throw new SandboxWorkloadPreparationError(
        `managed image catalog '${release}' failed validation`,
        { cause: error },
      );
    }
    return unavailableResult(
      input,
      `managed image catalog '${release}' is unavailable: ${diagnostic(error)}`,
    );
  }
  if (candidateSelection) {
    requireCandidateManagedImageCatalog(
      catalog,
      input.agentName,
      platform,
      acceptedCandidateContract,
    );
  } else {
    const trustedCatalogRevision = input.catalogPath
      ? (input.expectedCatalogRevision ?? null)
      : (input.catalogRevision ?? null);
    const catalogIdentity = requireCompleteManagedImageCatalog(
      catalog,
      release,
      platform,
      trustedCatalogRevision,
    );
    release = catalogIdentity.release;
  }

  return {
    source: resolveSandboxWorkloadSource({
      agentName: input.agentName,
      legacyDockerfilePath: input.legacyDockerfilePath,
      customDockerfilePath: input.customDockerfilePath,
      runtime: input.runtime,
      catalog,
      policy,
      candidateAgentsEnabled: candidateSelection,
    }),
    release,
    fallbackDiagnostic: null,
  };
}
