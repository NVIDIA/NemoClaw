// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type OpenRegularFile, openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { getBuildIdentity } from "../../core/version";
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
  type ShippedManagedImageAgent,
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

const EXACT_SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SOURCE_REVISION_REF_PATTERN = /^[0-9A-Fa-f]{39,64}$/u;

export interface PrepareSandboxWorkloadSourceInput {
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath?: string | null;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
  readonly version: string;
  readonly policy?: ManagedImageSelectionPolicy;
  readonly catalog?: ManagedImageContractCatalog | null;
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

function hasMatchingReleaseStamp(rootDir: string, version: string): boolean {
  let stampedVersion: string;
  try {
    stampedVersion = fs.readFileSync(path.join(rootDir, ".version"), "utf8").trim();
  } catch {
    return false;
  }
  if (!stampedVersion) return false;
  try {
    return normalizeManagedImageRelease(stampedVersion) === normalizeManagedImageRelease(version);
  } catch {
    return false;
  }
}

/**
 * Select the installed source revision for an untagged or exact-SHA install.
 * Tagged release installs retain the release catalog alias written by the
 * installer. The build identity, not the caller-provided ref, remains the
 * source of revision authority.
 */
export function installedManagedImageCatalogRevision(
  environment: NodeJS.ProcessEnv,
  rootDir: string,
): string | null {
  const identity = getBuildIdentity({ rootDir });
  const installRef = environment.NEMOCLAW_INSTALL_REF?.trim() ?? "";
  if (EXACT_SOURCE_REVISION_PATTERN.test(installRef)) {
    if (installRef !== identity.sourceRevision) {
      throw new SandboxWorkloadPreparationError(
        "the exact install ref does not match the installed build identity",
      );
    }
    return identity.sourceRevision;
  }
  if (SOURCE_REVISION_REF_PATTERN.test(installRef)) {
    throw new SandboxWorkloadPreparationError(
      "the exact install ref is not a supported lowercase 40-character source revision",
    );
  }

  if (hasMatchingReleaseStamp(rootDir, identity.nemoclawVersion)) return null;
  if (!EXACT_SOURCE_REVISION_PATTERN.test(identity.sourceRevision)) {
    throw new SandboxWorkloadPreparationError(
      "the installed build identity does not contain an exact managed-image source revision",
    );
  }

  return identity.sourceRevision;
}

export type LiveE2eManagedImageCatalog =
  | {
      readonly catalog: ManagedImageContractCatalog;
      readonly path?: never;
      readonly revision: string;
    }
  | { readonly catalog?: never; readonly path: string; readonly revision: string };

function parseInlineManagedImageCatalog(value: string): ManagedImageContractCatalog {
  const size = Buffer.byteLength(value, "utf8");
  if (size < 2 || size > 64 * 1024) {
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog must be bounded JSON",
    );
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as ManagedImageContractCatalog;
  } catch {
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog must be bounded JSON",
    );
  }
}

/** Select the trusted PR catalog only for an exact live E2E candidate. */
export function liveE2eManagedImageCatalog(
  environment: NodeJS.ProcessEnv,
): LiveE2eManagedImageCatalog | null {
  if (environment.GITHUB_ACTIONS !== "true" || environment.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    return null;
  }
  const inlineCatalog = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON?.trim();
  const configuredPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG?.trim();
  const workspace = environment.GITHUB_WORKSPACE?.trim();
  const catalogPath =
    configuredPath ||
    (workspace ? path.join(workspace, "dist", "e2e-managed-image-catalog.json") : "");
  if (inlineCatalog && configuredPath) {
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog has conflicting authorities",
    );
  }
  if (inlineCatalog) {
    const catalog = parseInlineManagedImageCatalog(inlineCatalog);
    const { revision } = requireCompleteManagedImageCatalog(catalog, null, null, null);
    return { catalog, revision };
  }
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
  const revision =
    environment.NEMOCLAW_E2E_MANAGED_IMAGE_REVISION?.trim() ??
    environment.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ??
    "";
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new SandboxWorkloadPreparationError(
      "the live E2E managed-image catalog requires an exact publication revision",
    );
  }
  return { path: catalogPath, revision };
}

function readExactManagedImageCatalog(catalogPath: string): ManagedImageContractCatalog {
  let catalog: OpenRegularFile | null = null;
  try {
    catalog = openRegularFileNoFollow(catalogPath);
    const metadata = catalog.stat();
    if (metadata.size < 2 || metadata.size > 64 * 1024) {
      throw new SandboxWorkloadPreparationError(
        "managed image catalog file must be a bounded regular file",
      );
    }
    const parsed: unknown = JSON.parse(catalog.readBytes(64 * 1024).toString("utf8"));
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
    catalog?.close();
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
  expectedRelease: string | null,
  expectedPlatform: ManagedImagePlatform | null,
  expectedRevision: string | null,
): {
  readonly contracts: ReadonlyMap<ShippedManagedImageAgent, ManagedImageContractV1>;
  readonly release: string;
  readonly revision: string;
} {
  const contracts = new Map<ShippedManagedImageAgent, ManagedImageContractV1>();
  let cohortRevision: string | null = null;
  let cohortRelease: string | null = null;
  let publicationCohort: string | null = null;
  let cohortPlatform = expectedPlatform;
  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    const candidate = catalog[agent];
    if (candidate === undefined) {
      throw new SandboxWorkloadPreparationError(
        `managed image catalog is incomplete; '${agent}' is missing`,
      );
    }
    try {
      const contract = parseManagedImageContractV1(
        candidate,
        agent,
        cohortPlatform ?? undefined,
      );
      cohortPlatform ??= contract.platform;
      if (
        expectedRevision === null &&
        expectedRelease !== null &&
        contract.source.release !== expectedRelease
      ) {
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
      contracts.set(agent, contract);
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
      "managed image catalog source revision does not match the trusted catalog revision",
    );
  }
  return { contracts, release: cohortRelease!, revision: cohortRevision! };
}

/** Read and validate every contract in one selected live E2E catalog. */
export function readLiveE2eManagedImageCatalogContracts(
  selected: LiveE2eManagedImageCatalog,
): ReadonlyMap<ShippedManagedImageAgent, ManagedImageContractV1> {
  const catalog = selected.catalog ?? readExactManagedImageCatalog(selected.path);
  if (
    JSON.stringify(Object.keys(catalog).sort()) !==
    JSON.stringify([...SHIPPED_MANAGED_IMAGE_AGENTS].sort())
  ) {
    throw new SandboxWorkloadPreparationError(
      "managed image catalog must contain only the shipped agent contracts",
    );
  }
  return requireCompleteManagedImageCatalog(catalog, null, null, selected.revision).contracts;
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

  if (input.catalog && input.catalogPath) {
    throw new SandboxWorkloadPreparationError(
      "managed image catalog has conflicting content authorities",
    );
  }

  if (candidateSelection && !input.catalog && !input.catalogPath) {
    throw new SandboxWorkloadPreparationError(
      `'${input.agentName}' is a release candidate and requires an exact managed image catalog`,
    );
  }

  const trustedCatalogRevision = input.expectedCatalogRevision ?? input.catalogRevision ?? null;
  if (
    input.expectedCatalogRevision &&
    input.catalogRevision &&
    input.expectedCatalogRevision !== input.catalogRevision
  ) {
    throw new SandboxWorkloadPreparationError(
      "managed image catalog has conflicting trusted revision authorities",
    );
  }
  if (trustedCatalogRevision !== null && !/^[0-9a-f]{40}$/u.test(trustedCatalogRevision)) {
    throw new SandboxWorkloadPreparationError(
      "managed image catalog trusted revision must be a lowercase 40-character SHA",
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
    catalog = input.catalog
      ? input.catalog
      : input.catalogPath
        ? readExactManagedImageCatalog(input.catalogPath)
        : await (
            dependencies.resolveCatalog ??
            ((options) => resolveManagedImageCatalogFromGhcr(options))
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
