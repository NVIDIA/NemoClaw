// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createInMemoryRuntimeProviderBundle } from "../../../test/helpers/runtime-provider-bundle";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry/types";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import {
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";
import type {
  RuntimeProviderBundle,
  RuntimeProviderWorkloadProfile,
} from "./runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./runtime-provider/current";
import { ManagedWorkloadCloneError, prepareManagedWorkloadCloneHandoff } from "./workload/clone";

const PORTABLE_PROFILE = {
  support: {
    exactDigestReferences: true,
    platforms: ["linux/amd64", "linux/arm64"],
    startupProfileContractVersions: [1],
    capabilityContractVersions: [1],
  },
  hostArchitectures: ["amd64", "arm64"],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

function provider(providerId: "docker" | "mxc"): RuntimeProviderBundle {
  if (providerId === "docker") return CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!;
  return createInMemoryRuntimeProviderBundle({
    providerId,
    workloadProfile: PORTABLE_PROFILE,
  });
}

function receipt(
  agent: ShippedManagedImageAgent,
  profile: ManagedStartupProfile,
): Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.99",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123456-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  };
}

function source(
  agent: ShippedManagedImageAgent,
  providerId: "docker" | "mxc",
  profile = managedStartupE2eProfile(agent),
): SandboxEntry {
  const workload = receipt(agent, profile);
  return {
    name: "source",
    agent,
    openshellDriver: providerId,
    imageTag: workload.reference,
    workload,
    provider: profile.inference.upstreamProvider,
    model: profile.inference.model,
    endpointUrl: profile.inference.upstreamEndpointUrl,
    endpointSource: profile.inference.upstreamEndpointUrl ? "onboard" : null,
    credentialEnv: "NVIDIA_API_KEY",
    preferredInferenceApi: profile.inference.api,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    toolDisclosure: profile.tools.disclosure,
    webSearchEnabled:
      profile.agentConfig.agent === "langchain-deepagents-code"
        ? false
        : profile.agentConfig.webSearch.enabled,
    webSearchProvider:
      profile.agentConfig.agent === "langchain-deepagents-code"
        ? null
        : profile.agentConfig.webSearch.provider,
    ...(profile.messaging.plan === null
      ? {}
      : {
          messaging: {
            schemaVersion: 1 as const,
            plan: profile.messaging.plan as unknown as NonNullable<
              SandboxEntry["messaging"]
            >["plan"],
          },
        }),
    ...(profile.dashboard.agent === "openclaw"
      ? {
          dashboardPort: profile.dashboard.port,
          dashboardRemoteBindPrepared: profile.dashboard.bindAddress === "0.0.0.0",
        }
      : {}),
    ...(profile.agent === "hermes" && profile.tools.enabledGateways.length > 0
      ? { hermesToolGateways: [...profile.tools.enabledGateways] }
      : {}),
    ...(profile.agentConfig.agent === "langchain-deepagents-code"
      ? {
          dcodeAutoApprovalMode: profile.agentConfig.autoApprovalMode,
          observabilityEnabled: profile.agentConfig.observabilityEnabled,
        }
      : {}),
  };
}

function runtimeSnapshot(providerId: string) {
  return {
    schemaVersion: 1 as const,
    providerId,
    providerHandle: `${providerId}:snapshot:source`,
    lifecycleState: "running" as const,
    lifecycleGeneration: "generation-source-1",
    runtime: {
      schemaVersion: 1 as const,
      providerId,
      runtime: { kind: `${providerId}-workload`, handle: `${providerId}:runtime:source` },
      acceleration: {
        kind: "gpu" as const,
        vendor: "nvidia",
        devices: ["nvidia.com/gpu=0"],
      },
    },
  };
}

function prepare(
  entry: SandboxEntry,
  selectedProvider: RuntimeProviderBundle,
  getHermesInferenceProviderName = vi.fn(
    (sandboxName: string) => `${sandboxName}-hermes-inference`,
  ),
) {
  return prepareManagedWorkloadCloneHandoff({
    source: entry,
    snapshot: {
      sandboxName: entry.name,
      agentType: entry.agent!,
      workload: entry.workload,
      runtimeSnapshot: runtimeSnapshot(selectedProvider.identity.id),
    },
    destinationSandboxName: "destination",
    destinationDashboardPort: entry.agent === "openclaw" ? 20_789 : null,
    provider: selectedProvider,
    getHermesInferenceProviderName,
  });
}

describe("prepareManagedWorkloadCloneHandoff", () => {
  it.each([
    ["docker", "openclaw"],
    ["docker", "hermes"],
    ["docker", "langchain-deepagents-code"],
    ["mxc", "openclaw"],
    ["mxc", "hermes"],
    ["mxc", "langchain-deepagents-code"],
  ] as const)("keeps %s clone handoff provider-bound for %s", (providerId, agent) => {
    const selectedProvider = provider(providerId);
    const entry = source(agent, providerId);

    const handoff = prepare(entry, selectedProvider);

    expect(handoff).toMatchObject({
      schemaVersion: 1,
      phase: "rebound",
      providerId,
      sourceSandboxName: "source",
      destinationSandboxName: "destination",
      runtimeSnapshot: {
        providerId,
        runtime: {
          providerId,
          acceleration: { kind: "gpu", vendor: "nvidia" },
        },
      },
      workload: {
        kind: "managed-image",
        reference: entry.imageTag,
        platform: "linux/amd64",
      },
      registryFields: {
        model: entry.model,
        preferredInferenceApi: "openai-completions",
      },
    });
    expect(handoff.rebound.profile.agent).toBe(agent);
    expect(handoff.workload.encodedProfile).toBe(handoff.rebound.encodedProfile);
    expect(JSON.stringify(handoff)).not.toContain("podman");
  });

  it("rebinds managed-tool Hermes to an injected destination provider identity", () => {
    const profile = validateManagedStartupProfile({
      ...managedStartupE2eProfile("hermes"),
      tools: {
        disclosure: "direct",
        enabledGateways: ["nous-web"],
      },
    });
    const entry = source("hermes", "mxc", profile);
    const resolver = vi.fn(() => "mxc-destination-inference");

    const handoff = prepare(entry, provider("mxc"), resolver);

    expect(resolver).toHaveBeenCalledWith("destination");
    expect(handoff.rebound.profile).toMatchObject({
      inference: { upstreamProvider: "mxc-destination-inference" },
      tools: { disclosure: "direct", enabledGateways: ["nous-web"] },
    });
    expect(handoff.registryFields).toMatchObject({
      provider: "nvidia",
      hermesInferenceProvider: "mxc-destination-inference",
      hermesToolGateways: ["nous-web"],
    });
  });

  it("carries the destination-bound messaging plan as typed registry state", () => {
    const profile = validateManagedStartupProfile({
      ...managedStartupE2eProfile("openclaw"),
      messaging: {
        plan: {
          schemaVersion: 1,
          sandboxName: "source",
          agent: "openclaw",
          workflow: "onboard",
          channels: [
            {
              channelId: "telegram",
              configured: true,
              active: true,
              disabled: false,
              inputs: [
                { inputId: "botToken", credentialAvailable: true },
                { inputId: "allowedIds", value: ["123456"] },
              ],
            },
          ],
          disabledChannels: [],
          credentialBindings: [],
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
          stateUpdates: [],
          healthChecks: [],
        },
      },
    });
    const entry = source("openclaw", "docker", profile);

    const handoff = prepare(entry, provider("docker"));

    expect(handoff.messaging).toMatchObject({
      schemaVersion: 1,
      plan: {
        sandboxName: "destination",
        credentialBindings: [{ providerName: "destination-telegram-bridge" }],
      },
    });
    expect(JSON.stringify(handoff.messaging)).not.toContain("credentialHash");
  });

  it("fails closed on stale managed authority, provider drift, and missing clone authority", () => {
    const entry = source("openclaw", "mxc");
    const selectedProvider = provider("mxc");
    expect(() =>
      prepareManagedWorkloadCloneHandoff({
        source: entry,
        snapshot: {
          sandboxName: "source",
          agentType: "openclaw",
          workload: {
            ...(entry.workload as Extract<
              SandboxWorkloadReceipt,
              { readonly kind: "managed-image" }
            >),
            sourceRevision: "c".repeat(40),
          },
          runtimeSnapshot: runtimeSnapshot("mxc"),
        },
        destinationSandboxName: "destination",
        destinationDashboardPort: 20_789,
        provider: selectedProvider,
        getHermesInferenceProviderName: vi.fn(),
      }),
    ).toThrow(/no longer matches/u);

    expect(() => prepare(entry, provider("docker"))).toThrow(/does not match selected provider/u);

    const unauthorized = {
      ...selectedProvider,
      mutationAuthority: {
        ...selectedProvider.mutationAuthority,
        operations:
          selectedProvider.mutationAuthority.supported === true
            ? selectedProvider.mutationAuthority.operations.filter(
                (operation) => operation !== "clone",
              )
            : [],
      },
    } as RuntimeProviderBundle;
    expect(() => prepare(entry, unauthorized)).toThrow(ManagedWorkloadCloneError);
  });
});
