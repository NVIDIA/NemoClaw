// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxEntry } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "./managed-image/contract";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import {
  ManagedWorkloadRebuildError,
  managedWorkloadRebuildDependencies,
  prepareManagedWorkloadRebuildHandoff,
} from "./workload/rebuild";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const PLATFORM = "linux/amd64" as const;
const ORIGINAL_PREPARE = managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource;

function contract(
  agent: ManagedImageAgent,
  digestByte: string,
  release: string,
  revision: string,
  cohort: `ghrun-${number}-${number}`,
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${digestByte.repeat(32)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: { repository: MANAGED_IMAGE_SOURCE_REPOSITORY, revision, release, cohort },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

const INSTALLED = contract("pi", "1b", "v0.0.99", "c".repeat(40), "ghrun-7927-2");
const RELEASE_CATALOG = Object.fromEntries(
  SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [
    agent,
    contract(agent, String(index + 2).repeat(2), "v0.0.100", "e".repeat(40), "ghrun-8818-1"),
  ]),
);

function piEntry(): SandboxEntry {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("pi"));
  return {
    name: "rebuild-pi",
    agent: "pi",
    openshellDriver: "docker",
    fromDockerfile: null,
    imageTag: INSTALLED.reference,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: INSTALLED.reference,
      platform: PLATFORM,
      release: INSTALLED.source.release,
      sourceRevision: INSTALLED.source.revision,
      sourceCohort: INSTALLED.source.cohort,
      capabilityContractVersion: INSTALLED.capabilityContractVersion,
      startupProfileContractVersion: INSTALLED.startupProfileContractVersion,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } as unknown as SandboxEntry;
}

function runtime(
  providerId: string,
  agents: readonly ManagedImageAgent[],
): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName: providerId,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [PLATFORM],
      agents,
      startupProfileContractVersions: [1],
      capabilityContractVersions: [1],
    },
  };
}

function provider(providerId: string, agents: readonly ManagedImageAgent[]): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: providerId },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          agents,
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => true,
    },
    mutationAuthority: { providerId, supported: true, operations: ["rebuild"] },
  } as unknown as RuntimeProviderBundle;
}

describe("Pi managed rebuild", () => {
  afterEach(() => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = ORIGINAL_PREPARE;
  });

  it("rebuilds Pi from the complete all-agent release catalog", async () => {
    const resolveCatalog = vi.fn(async () => RELEASE_CATALOG);
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = (input) =>
      ORIGINAL_PREPARE(input, { resolveCatalog });

    const handoff = await prepareManagedWorkloadRebuildHandoff(piEntry(), {
      runtime: runtime("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
      provider: provider("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
      version: "0.0.100",
    });

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
      release: "v0.0.100",
      platform: PLATFORM,
    });
    expect(handoff).toMatchObject({
      agent: "pi",
      previousReceipt: { kind: "managed-image", release: "v0.0.99" },
      replacement: {
        release: "v0.0.100",
        source: { kind: "managed-image", reference: RELEASE_CATALOG.pi?.reference },
      },
    });
  });

  it("refuses a Pi rebuild before catalog resolution when the runtime does not qualify Pi", async () => {
    const qualified: readonly ManagedImageAgent[] = [
      "openclaw",
      "hermes",
      "langchain-deepagents-code",
    ];
    const resolveCatalog = vi.fn(async () => RELEASE_CATALOG);
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = (input) =>
      ORIGINAL_PREPARE(input, { resolveCatalog });

    await expect(
      prepareManagedWorkloadRebuildHandoff(piEntry(), {
        runtime: runtime("podman", qualified),
        provider: provider("podman", qualified),
        version: "0.0.100",
      }),
    ).rejects.toThrow(
      new ManagedWorkloadRebuildError(
        "Managed image workload is required for 'pi', but driver 'podman' is not qualified for that agent.",
      ),
    );
    expect(resolveCatalog).not.toHaveBeenCalled();
  });
});
