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
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import type { BuiltManagedStartupOnboardProfile } from "./managed-startup/onboard-profile";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import {
  buildManagedWorkloadRebuildReceipt,
  managedWorkloadRebuildDependencies,
  managedWorkloadRebuildHandoffMatchesEntry,
  prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
  type ManagedWorkloadRebuildHandoff,
  type ManagedWorkloadReceipt,
} from "./workload/rebuild";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const ORIGINAL_PREPARE = managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource;

function managedContract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: ManagedImagePlatform = "linux/amd64",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digit = generation === "old" ? "a" : "b";
  const digest = `sha256:${digit.repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: digit.repeat(40),
      release: generation === "old" ? "v0.0.99" : "v0.0.100",
      cohort: generation === "old" ? "ghrun-100-1" : "ghrun-200-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function profileTransport(agent: ShippedManagedImageAgent): BuiltManagedStartupOnboardProfile {
  const profile = managedStartupE2eProfile(agent);
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    profile,
    encodedProfile: encodedProfile as BuiltManagedStartupOnboardProfile["encodedProfile"],
    startupProfileSha256: createHash("sha256")
      .update(encodedProfile, "utf8")
      .digest("hex"),
    credentialProxyReplayRequired: false,
  };
}

function receipt(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: ManagedImagePlatform = "linux/amd64",
): ManagedWorkloadReceipt {
  const image = managedContract(agent, generation, platform);
  const transport = profileTransport(agent);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: image.reference,
    platform,
    release: image.source.release,
    sourceRevision: image.source.revision,
    sourceCohort: image.source.cohort,
    capabilityContractVersion: image.capabilityContractVersion,
    startupProfileContractVersion: image.startupProfileContractVersion,
    encodedProfile: transport.encodedProfile,
    startupProfileSha256: transport.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function entry(
  agent: ShippedManagedImageAgent,
  platform: ManagedImagePlatform = "linux/amd64",
): SandboxEntry {
  const workload = receipt(agent, "old", platform);
  return {
    name: `rebuild-${agent}`,
    agent,
    openshellDriver: "mxc",
    fromDockerfile: null,
    imageTag: workload.reference,
    workload,
  };
}

function runtime(
  providerId = "mxc",
  platform: ManagedImagePlatform = "linux/amd64",
): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName: providerId,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [platform],
      startupProfileContractVersions: [1],
      capabilityContractVersions: [1],
    },
  };
}

function provider(
  providerId = "mxc",
  options: { readonly acceptsReceipt?: boolean; readonly authorizesRebuild?: boolean } = {},
): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: providerId },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => options.acceptsReceipt !== false,
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: options.authorizesRebuild === false ? [] : ["rebuild"],
    },
  } as unknown as RuntimeProviderBundle;
}

function replacement(agent: ShippedManagedImageAgent) {
  const image = managedContract(agent, "new");
  return {
    source: {
      kind: "managed-image" as const,
      reference: image.reference,
      contract: image,
    },
    release: image.source.release,
    fallbackDiagnostic: null,
  };
}

function completeHandoff(
  agent: ShippedManagedImageAgent,
  catalog: Awaited<ReturnType<typeof prepareManagedWorkloadRebuildHandoff>>,
): ManagedWorkloadRebuildHandoff {
  return {
    ...catalog!,
    replacementProfile: profileTransport(agent),
  };
}

afterEach(() => {
  managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = ORIGINAL_PREPARE;
});

describe("managed workload rebuild preflight", () => {
  it.each(AGENTS)(
    "prepares exact current-release authority for %s without a Dockerfile fallback",
    async (agent) => {
      const prepare = vi.fn(async () => replacement(agent));
      managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

      const handoff = await prepareManagedWorkloadRebuildHandoff(entry(agent), {
        runtime: runtime(),
        provider: provider(),
        version: "0.0.100",
      });

      expect(handoff).toMatchObject({
        schemaVersion: 1,
        providerId: "mxc",
        agent,
        previousReceipt: {
          kind: "managed-image",
          platform: "linux/amd64",
          release: "v0.0.99",
        },
        replacement: {
          source: {
            kind: "managed-image",
            contract: { agent, platform: "linux/amd64" },
          },
          release: "v0.0.100",
        },
      });
      expect(prepare).toHaveBeenCalledWith({
        agentName: agent,
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: runtime(),
        version: "0.0.100",
        policy: "require-managed",
      });
    },
  );

  it("returns null for a custom workload without resolving a catalog", async () => {
    const prepare = vi.fn();
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

    await expect(
      prepareManagedWorkloadRebuildHandoff(
        {
          name: "custom",
          agent: "openclaw",
          openshellDriver: "mxc",
          fromDockerfile: "/tmp/Dockerfile",
          imageTag: "custom:local",
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile",
            reference: "custom:local",
            shared: false,
          },
        },
        { runtime: runtime(), provider: provider() },
      ),
    ).resolves.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "provider identity",
      entry("openclaw"),
      runtime("other"),
      provider("mxc"),
      /does not match provider/u,
    ],
    [
      "recorded platform",
      entry("openclaw", "linux/arm64"),
      runtime("mxc", "linux/amd64"),
      provider("mxc"),
      /targets 'linux[/]arm64'/u,
    ],
    [
      "workload capability",
      entry("openclaw"),
      runtime(),
      provider("mxc", { acceptsReceipt: false }),
      /does not accept/u,
    ],
    [
      "mutation authority",
      entry("openclaw"),
      runtime(),
      provider("mxc", { authorizesRebuild: false }),
      /does not authorize 'rebuild'/u,
    ],
  ] as const)("rejects %s drift before catalog resolution", async (_label, row, target, selected, error) => {
    const prepare = vi.fn();
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

    await expect(
      prepareManagedWorkloadRebuildHandoff(row, {
        runtime: target,
        provider: selected,
      }),
    ).rejects.toThrow(error);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("revalidates retained profile and receipt authority against the live row", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(
      async () => replacement("openclaw"),
    );
    const row = entry("openclaw");
    const catalog = await prepareManagedWorkloadRebuildHandoff(row, {
      runtime: runtime(),
      provider: provider(),
    });

    expect(
      managedWorkloadRebuildHandoffMatchesEntry(catalog!, row, provider()),
    ).toBe(true);
    expect(
      managedWorkloadRebuildHandoffMatchesEntry(
        catalog!,
        { ...row, imageTag: receipt("openclaw", "new").reference },
        provider(),
      ),
    ).toBe(false);
    expect(
      managedWorkloadRebuildHandoffMatchesEntry(catalog!, row, provider("other")),
    ).toBe(false);
  });

  it("materializes a shared exact-digest replacement receipt", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(
      async () => replacement("hermes"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("hermes"), {
      runtime: runtime(),
      provider: provider(),
    });
    const complete = completeHandoff("hermes", catalog);

    const result = buildManagedWorkloadRebuildReceipt(complete, provider());

    expect(result).toEqual(receipt("hermes", "new"));
    expect(result.shared).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rebinds the retained immutable source through the selected provider contract", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(
      async () => replacement("langchain-deepagents-code"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(
      entry("langchain-deepagents-code"),
      { runtime: runtime(), provider: provider() },
    );

    const source = prepareSandboxWorkloadSourceFromRebuildHandoff(
      catalog!,
      runtime(),
      provider(),
    );

    expect(source).toEqual(replacement("langchain-deepagents-code"));
    expect(() =>
      prepareSandboxWorkloadSourceFromRebuildHandoff(
        catalog!,
        runtime("other"),
        provider(),
      ),
    ).toThrow(/does not belong to the selected runtime provider/u);
  });
});
