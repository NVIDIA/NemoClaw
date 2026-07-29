// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxMessagingPlan } from "../messaging";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORM,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import { encodeManagedStartupProfile, type ManagedStartupProfile } from "./managed-startup/profile";
import {
  managedWorkloadRebuildDependencies,
  managedWorkloadRebuildHandoffMatchesEntry,
  managedWorkloadRebuildProfileEnvironment,
  prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
  stageManagedWorkloadRebuildProfile,
} from "./workload/rebuild";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const RUNTIME = {
  driverName: "docker",
  managedImageSelectionPolicy: "prefer-managed",
  legacyDockerfileBuilds: true,
  managedImages: {
    exactDigestReferences: true,
    platforms: [MANAGED_IMAGE_PLATFORM],
    startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
    capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
  },
} as const satisfies SandboxWorkloadRuntimeCapabilities;

const OLD_RELEASE = "v0.0.97";
const NEW_RELEASE = "v0.0.98";
const OLD_REVISION = "1".repeat(40);
const NEW_REVISION = "2".repeat(40);
const OLD_COHORT = "ghrun-123-1";
const NEW_COHORT = "ghrun-456-2";

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function contract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest: `sha256:${string}` = `sha256:${(generation === "old" ? "a" : "b").repeat(64)}`;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest: digest as `sha256:${string}`,
    reference: `${image}@${digest}` as ManagedImageContractV1["reference"],
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: generation === "old" ? OLD_REVISION : NEW_REVISION,
      release: generation === "old" ? OLD_RELEASE : NEW_RELEASE,
      cohort: generation === "old" ? OLD_COHORT : NEW_COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function entry(
  agent: ShippedManagedImageAgent,
  options: {
    corporateCa?: boolean;
    credentialProxyReplayRequired?: boolean;
    profile?: ManagedStartupProfile;
  } = {},
): SandboxEntry {
  const profile =
    options.profile ??
    managedStartupE2eProfile(
      agent,
      false,
      options.corporateCa === true,
      options.credentialProxyReplayRequired === true,
    );
  const encodedProfile = encodeManagedStartupProfile(profile);
  const old = contract(agent, "old");
  const workload: SandboxWorkloadReceipt = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: old.reference,
    release: old.source.release,
    sourceRevision: old.source.revision,
    sourceCohort: old.source.cohort,
    capabilityContractVersion: old.capabilityContractVersion,
    startupProfileContractVersion: old.startupProfileContractVersion,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: options.credentialProxyReplayRequired === true,
    ...(options.corporateCa
      ? {
          corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString(
            "base64",
          ),
        }
      : {}),
    shared: true,
  };
  return {
    name: "alpha",
    agent: agent === "openclaw" ? null : agent,
    fromDockerfile: null,
    imageTag: old.reference,
    workload,
  };
}

function installReplacement(agent: ShippedManagedImageAgent) {
  const replacement = contract(agent, "new");
  const spy = vi
    .spyOn(managedWorkloadRebuildDependencies, "prepareSandboxWorkloadSource")
    .mockResolvedValue({
      source: { kind: "managed-image", reference: replacement.reference, contract: replacement },
      release: NEW_RELEASE,
      fallbackDiagnostic: null,
    });
  return { replacement, spy };
}

function messagingPlan(agent: "openclaw" | "hermes"): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent,
    workflow: "rebuild",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function profileInput(
  agent: ShippedManagedImageAgent,
): Parameters<typeof stageManagedWorkloadRebuildProfile>[1] {
  const dashboardEnabled = agent !== "langchain-deepagents-code";
  return {
    inference: {
      routeProvider: "inference",
      upstreamProvider: "nvidia-prod",
      model: "nvidia/new-model",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl:
        agent === "langchain-deepagents-code" ? "https://integrate.api.nvidia.com/v1" : null,
      api: "openai-completions",
      primaryModelRef: agent === "openclaw" ? "inference/nvidia/new-model" : null,
      compatibility: agent === "openclaw" ? {} : null,
    },
    chatUiUrl: dashboardEnabled ? "http://127.0.0.1:18789" : "",
    effectiveDashboardPort: dashboardEnabled ? 18_789 : 0,
    manageDashboard: dashboardEnabled,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: { config: null, enabled: false },
    webSearch:
      agent === "langchain-deepagents-code"
        ? null
        : { fetchEnabled: true, provider: agent === "hermes" ? "tavily" : "brave" },
    toolDisclosure: "direct",
    hermesToolGateways: agent === "hermes" ? ["nous-image"] : [],
    messagingPlan: agent === "langchain-deepagents-code" ? null : messagingPlan(agent),
    dcodeAutoApprovalMode: agent === "langchain-deepagents-code" ? "thread-opt-in" : "disabled",
    observabilityEnabled: agent === "langchain-deepagents-code",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("managed workload rebuild handoff", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("validates old %s authority and pins the current all-agent release image", async (agent) => {
    const oldEntry = entry(agent);
    const { replacement, spy } = installReplacement(agent);

    const handoff = await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.previousReceipt.reference).toBe(oldEntry.imageTag);
    expect(handoff?.replacement.source.reference).toBe(replacement.reference);
    expect(handoff?.replacement.source.reference).not.toBe(oldEntry.imageTag);
    expect(handoff?.replacement.source.contract.source).toEqual({
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: NEW_REVISION,
      release: NEW_RELEASE,
      cohort: NEW_COHORT,
    });
    expect(handoff?.previousProfile.agent).toBe(agent);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: agent,
        runtime: RUNTIME,
        version: NEW_RELEASE,
        policy: "require-managed",
      }),
    );
    expect(prepareSandboxWorkloadSourceFromRebuildHandoff(handoff!, RUNTIME).source).toEqual(
      handoff?.replacement.source,
    );
    expect(managedWorkloadRebuildHandoffMatchesEntry(handoff!, oldEntry)).toBe(true);
  });

  it("retains validated corporate CA bytes while selecting a new OpenClaw image", async () => {
    const oldEntry = entry("openclaw", { corporateCa: true });
    installReplacement("openclaw");

    const handoff = await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    });

    expect(handoff?.corporateCa?.pem).toBe(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM);
  });

  it("preserves credential-proxy replay while allowing other profile env to change", async () => {
    const oldEntry = entry("hermes", { credentialProxyReplayRequired: true });
    installReplacement("hermes");
    const handoff = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;

    expect(
      managedWorkloadRebuildProfileEnvironment(handoff, {
        HTTPS_PROXY: "http://user:password@proxy.example.test:8443",
        NEMOCLAW_CONTEXT_WINDOW: "196608",
      }),
    ).toEqual({
      HTTPS_PROXY: "http://user:password@proxy.example.test:8443",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
    });
  });

  it("renders a complete OpenClaw replacement profile before mutation while preserving receipt-only tuning", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("openclaw"),
    ) as DeepMutable<ManagedStartupProfile>;
    if (previous.agentConfig.agent !== "openclaw") throw new Error("fixture drift");
    previous.proxy.managedHost = "10.44.0.9";
    previous.proxy.managedPort = 4312;
    previous.tuning.contextWindow = 196_608;
    previous.tuning.maxTokens = 16_384;
    previous.tuning.reasoning = true;
    previous.inference.inputModalities = ["text", "image"];
    previous.agentConfig.agentTimeoutSeconds = 777;
    previous.agentConfig.heartbeatEvery = "45s";
    previous.agentConfig.extraAgents = {
      agents: [{ id: "reviewer" }],
      defaults: { subagents: {} },
      main: { model: "primary" },
    };
    previous.agentConfig.otel = {
      enabled: true,
      endpointUrl: "http://otel.example.test:4318",
      serviceName: "custom-openclaw",
      sampleRate: 0.25,
    };
    previous.agentConfig.minimalBootstrap = false;

    installReplacement("openclaw");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("openclaw", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(catalog, profileInput("openclaw"), {});

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: {
        model: "nvidia/new-model",
        upstreamProvider: "nvidia-prod",
        inputModalities: ["image", "text"],
      },
      tools: { disclosure: "direct" },
      proxy: { managedHost: "10.44.0.9", managedPort: 4312 },
      tuning: { contextWindow: 196_608, maxTokens: 16_384, reasoning: true },
      agentConfig: {
        agent: "openclaw",
        agentTimeoutSeconds: 777,
        heartbeatEvery: "45s",
        minimalBootstrap: false,
        otel: {
          enabled: true,
          endpointUrl: "http://otel.example.test:4318",
          serviceName: "custom-openclaw",
          sampleRate: 0.25,
        },
        webSearch: { enabled: true, provider: "brave" },
      },
    });
    expect(handoff.replacementProfile.profile.messaging.plan).not.toBeNull();
    expect(handoff.replacementProfile.encodedProfile).not.toBe(
      catalog.previousReceipt.encodedProfile,
    );
  });

  it("preserves Hermes receipt-only context and proxy while applying current tools and messaging", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("hermes"),
    ) as DeepMutable<ManagedStartupProfile>;
    previous.proxy.managedHost = "10.55.0.7";
    previous.proxy.managedPort = 5312;
    previous.tuning.contextWindow = 262_144;

    installReplacement("hermes");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("hermes", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(catalog, profileInput("hermes"), {});

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: { model: "nvidia/new-model" },
      tools: { disclosure: "direct", enabledGateways: ["nous-image"] },
      proxy: { managedHost: "10.55.0.7", managedPort: 5312 },
      tuning: { contextWindow: 262_144, maxTokens: null, reasoning: null },
      agentConfig: {
        agent: "hermes",
        webSearch: { enabled: true, provider: "tavily" },
      },
    });
    expect(handoff.replacementProfile.profile.messaging.plan).not.toBeNull();
  });

  it("preserves DCode receipt-only proxy while applying current disclosure, approval, and observability", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("langchain-deepagents-code"),
    ) as DeepMutable<ManagedStartupProfile>;
    previous.proxy.managedHost = "10.66.0.5";
    previous.proxy.managedPort = 6312;

    installReplacement("langchain-deepagents-code");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("langchain-deepagents-code", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(
      catalog,
      profileInput("langchain-deepagents-code"),
      {},
    );

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: {
        model: "nvidia/new-model",
        upstreamEndpointUrl: "https://integrate.api.nvidia.com/v1",
      },
      tools: { disclosure: "direct" },
      proxy: { managedHost: "10.66.0.5", managedPort: 6312 },
      agentConfig: {
        agent: "langchain-deepagents-code",
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
    });
  });

  it("fails profile rendering before a managed credential proxy can be silently dropped", async () => {
    const oldEntry = entry("openclaw", { credentialProxyReplayRequired: true });
    installReplacement("openclaw");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;

    expect(() => stageManagedWorkloadRebuildProfile(catalog, profileInput("openclaw"), {})).toThrow(
      "changed the durable credential-proxy requirement",
    );
  });

  it("fails closed instead of resolving a catalog for a managed image with no receipt", async () => {
    const oldEntry = entry("openclaw");
    delete oldEntry.workload;
    const { spy } = installReplacement("openclaw");

    await expect(
      prepareManagedWorkloadRebuildHandoff(oldEntry, {
        runtime: RUNTIME,
        version: NEW_RELEASE,
      }),
    ).rejects.toThrow("no valid durable workload receipt");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when the current complete catalog is unavailable", async () => {
    vi.spyOn(managedWorkloadRebuildDependencies, "prepareSandboxWorkloadSource").mockRejectedValue(
      new Error("cohort is torn"),
    );

    await expect(
      prepareManagedWorkloadRebuildHandoff(entry("langchain-deepagents-code"), {
        runtime: RUNTIME,
        version: NEW_RELEASE,
      }),
    ).rejects.toThrow("complete managed-image catalog is unavailable or invalid");
  });
});
