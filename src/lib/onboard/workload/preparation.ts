// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  ManagedImageCatalogUnavailableError,
  normalizeManagedImageRelease,
  resolveManagedImageCatalogFromGhcr,
} from "../managed-image/catalog";
import {
  isShippedManagedImageAgent,
  type ManagedImageContractCatalog,
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
}) => Promise<ManagedImageContractCatalog>;

export interface PrepareSandboxWorkloadSourceInput {
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath?: string | null;
  readonly runtime: SandboxWorkloadRuntimeCapabilities;
  readonly version: string;
  readonly policy?: ManagedImageSelectionPolicy;
  readonly catalogPath?: string | null;
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
): void {
  let cohortRevision: string | null = null;
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
      if (contract.source.release !== expectedRelease) {
        throw new SandboxWorkloadPreparationError(
          `managed image catalog contract for '${agent}' belongs to '${contract.source.release}', not '${expectedRelease}'`,
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
  const cannotSelectManaged =
    input.customDockerfilePath != null ||
    !isShippedManagedImageAgent(input.agentName) ||
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
      }),
      release: null,
      fallbackDiagnostic: null,
    };
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
        )({ release, platform });
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
  requireCompleteManagedImageCatalog(catalog, release, platform);

  return {
    source: resolveSandboxWorkloadSource({
      agentName: input.agentName,
      legacyDockerfilePath: input.legacyDockerfilePath,
      customDockerfilePath: input.customDockerfilePath,
      runtime: input.runtime,
      catalog,
      policy,
    }),
    release,
    fallbackDiagnostic: null,
  };
}
