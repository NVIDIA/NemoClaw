// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  serializedHostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../../../test/helpers/host-local-inference-receipt";
import type { SandboxWorkloadReceipt } from "../state/registry/types";
import { createSandboxHostLocalInferenceProvenance } from "../state/registry/host-local-inference";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
} from "./managed-image/contract";
import { encodeManagedStartupProfile } from "./managed-startup/profile";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../state/onboard-session.js");
const {
  assertBaselineExclusionsMatchCreateIntent,
  baselineExclusionsForCreate,
  buildCreatedSandboxRegistryEntry,
  creationFidelity,
  registerCreatedSandbox,
  selection,
} = requireDist("./sandbox-registration.ts") as typeof import("./sandbox-registration");

const runtimeFields = {
  gpuEnabled: true,
  hostGpuDetected: true,
  sandboxGpuEnabled: true,
  sandboxGpuMode: "auto",
  sandboxGpuDevice: null,
  openshellDriver: "docker",
  openshellVersion: "0.1.2",
};

function managedWorkloadReceipt(
  agent: ManagedImageAgent,
): Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
  const digest = agent === "openclaw" ? "a" : "b";
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${digest.repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.100",
    sourceRevision: "d".repeat(40),
    sourceCohort: "ghrun-9356-1",
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function createdRegistryEntryInput(
  overrides: Partial<Parameters<typeof buildCreatedSandboxRegistryEntry>[0]> = {},
): Parameters<typeof buildCreatedSandboxRegistryEntry>[0] {
  return {
    sandboxName: "demo",
    inferenceSelection: {
      model: "llama",
      provider: "openai-compatible",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    },
    runtimeFields,
    agent: null,
    agentVersionKnown: true,
    imageTag: null,
    appliedPolicies: [],
    plannedMessagingState: undefined,
    hermesToolGateways: [],
    hermesDashboardState: { enabled: false, config: null },
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...overrides,
  };
}

describe("buildCreatedSandboxRegistryEntry", () => {
  it("records explicit OpenClaw identity for a managed workload receipt (#9356)", () => {
    const workload = managedWorkloadReceipt("openclaw");
    const entry = buildCreatedSandboxRegistryEntry(
      createdRegistryEntryInput({ imageTag: workload.reference, workload }),
    );
    const authority = requireDist(
      "./workload/authority.ts",
    ) as typeof import("./workload/authority");

    expect(entry.agent).toBe("openclaw");
    expect(authority.readManagedWorkloadAuthority(entry)?.agent).toBe("openclaw");
  });

  it("keeps the legacy OpenClaw registry identity for a custom image (#9356)", () => {
    const entry = buildCreatedSandboxRegistryEntry(
      createdRegistryEntryInput({
        agentVersionKnown: false,
        fromDockerfile: "/tmp/Dockerfile.custom",
        imageTag: "custom-openclaw:latest",
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: "custom-openclaw:latest",
          shared: false,
        },
      }),
    );

    expect(entry.agent).toBeNull();
  });

  it("rejects a managed receipt for a different agent before registry mutation (#9356)", () => {
    const workload = managedWorkloadReceipt("hermes");
    const registerSandbox = vi.fn();

    expect(() =>
      registerCreatedSandbox({
        ...createdRegistryEntryInput({ imageTag: workload.reference, workload }),
        registerSandbox,
      }),
    ).toThrow(/agent identity does not match its managed workload receipt/u);
    expect(registerSandbox).not.toHaveBeenCalled();
  });

  it("copies matching session profile provenance into the durable registry (#8246)", () => {
    const provenance = {
      schemaVersion: 1,
      catalogDigest: `sha256:${"1".repeat(64)}`,
      preset: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"2".repeat(64)}`,
        displayName: "Example Spark profile",
        supportState: "experimental",
      },
      recipe: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"3".repeat(64)}`,
        backend: "vllm",
      },
      model: { id: "example/model", revision: "revision-1" },
      runtimeImage: null,
      estimatedImageDownloadBytes: null,
      estimatedModelDownloadBytes: null,
    } as const;
    const loadSession = vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "demo",
      servingProfileProvenance: provenance,
    });

    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "example/model",
        provider: "vllm-local",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.servingProfileProvenance).toEqual(provenance);
    loadSession.mockRestore();
  });

  it("blocks create intent while a baseline policy transaction needs repair (#7178)", () => {
    const registry = requireDist("../state/registry.js");
    const transitionSpy = vi.spyOn(registry, "getBaselineExclusionTransition").mockReturnValue({
      id: "tx-1",
      operation: "exclude",
      exclusion: {
        version: 1,
        agent: "openclaw",
        key: "nous_research",
        digest: "approved",
      },
      targetLiveDigest: null,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(() => baselineExclusionsForCreate("alpha")).toThrow(
      /policy exclude.*needs repair before sandbox creation/i,
    );

    transitionSpy.mockRestore();
  });

  it("rejects a resolved create intent when durable baseline exclusions changed (#7194)", () => {
    const registry = requireDist("../state/registry.js");
    const transitionSpy = vi
      .spyOn(registry, "getBaselineExclusionTransition")
      .mockReturnValue(null);
    const exclusionsSpy = vi.spyOn(registry, "getBaselineExclusions").mockReturnValue([
      {
        version: 1,
        agent: "openclaw",
        key: "nous_research",
        digest: "b".repeat(64),
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
      },
    ]);
    try {
      expect(() =>
        assertBaselineExclusionsMatchCreateIntent("alpha", [
          {
            version: 1,
            agent: "openclaw",
            key: "nous_research",
            digest: "a".repeat(64),
            acknowledgedAt: "2026-07-19T00:00:00.000Z",
          },
        ]),
      ).toThrow(/changed while sandbox creation was being prepared/i);
    } finally {
      exclusionsSpy.mockRestore();
      transitionSpy.mockRestore();
    }
  });

  it("records the final created sandbox metadata with configured messaging channels", () => {
    const plannedMessagingState = {
      schemaVersion: 1 as const,
      plan: { sandboxName: "demo" },
    };
    const openclawImagePluginInstalls = [
      {
        id: "weather",
        installPath: "/sandbox/.openclaw/extensions/weather",
        loadPaths: ["/opt/weather-plugin"],
      },
    ];

    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "openai-compatible",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: "nemoclaw-demo:123",
      openclawImagePluginInstalls,
      appliedPolicies: ["discord", "slack"],
      observabilityEnabled: true,
      dcodeAutoApprovalMode: "thread-opt-in",
      policyTier: "restricted",
      webSearchEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "api_key",
      plannedMessagingState: plannedMessagingState as any,
      hermesToolGateways: ["filesystem"],
      hermesDashboardState: {
        enabled: true,
        config: { enabled: true, port: 18790, internalPort: 19123, tuiEnabled: true },
      },
      dashboardPort: 18789,
      lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
      lifecycleLiveIdentityFingerprint: "d".repeat(64),
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      hostMounts: [{ source: "/srv/project", target: "/sandbox/project", readOnly: true }],
    });

    expect(entry).toMatchObject({
      name: "demo",
      model: "llama",
      provider: "openai-compatible",
      endpointUrl: "https://example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      imageTag: "nemoclaw-demo:123",
      openclawImagePluginInstalls,
      policies: ["discord", "slack"],
      toolDisclosure: "progressive",
      observabilityEnabled: true,
      dcodeAutoApprovalMode: "thread-opt-in",
      policyTier: "restricted",
      webSearchEnabled: true,
      fromDockerfile: "/tmp/Dockerfile.custom",
      hermesAuthMethod: "api_key",
      hermesToolGateways: ["filesystem"],
      hermesDashboardEnabled: true,
      hermesDashboardPort: 18790,
      hermesDashboardInternalPort: 19123,
      hermesDashboardTui: true,
      dashboardPort: 18789,
      lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
      lifecycleLiveIdentityFingerprint: "d".repeat(64),
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      gpuEnabled: true,
      openshellDriver: "docker",
      openshellVersion: "0.1.2",
      hostMounts: [{ source: "/srv/project", target: "/sandbox/project", readOnly: true }],
    });
    expect(entry.agent).toBeNull();
    expect(entry.agentVersion).toBeTruthy();
    expect(entry.nemoclawVersion).toBeTruthy();
    expect(entry.openclawImagePluginInstalls).not.toBe(openclawImagePluginInstalls);
    expect(entry.openclawImagePluginInstalls?.[0]).not.toBe(openclawImagePluginInstalls[0]);
    expect(entry.openclawImagePluginInstalls?.[0]?.loadPaths).not.toBe(
      openclawImagePluginInstalls[0]?.loadPaths,
    );
    expect(entry.messaging).toBe(plannedMessagingState);
    const rawEntry = entry as unknown as Record<string, unknown>;
    expect(rawEntry.messagingChannels).toBeUndefined();
    expect(rawEntry.messagingChannelConfig).toBeUndefined();
    expect(rawEntry.disabledChannels).toBeUndefined();
  });

  it("skips stale messaging plans without writing legacy messaging fields", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "",
        provider: "",
        endpointUrl: "",
        credentialEnv: "",
        preferredInferenceApi: "",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: "",
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: false,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: {
        schemaVersion: 1 as const,
        plan: { sandboxName: "other" },
      } as any,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.model).toBeNull();
    expect(entry.provider).toBeNull();
    expect(entry.endpointUrl).toBeNull();
    expect(entry.credentialEnv).toBeNull();
    expect(entry.preferredInferenceApi).toBeNull();
    expect(entry.nimContainer).toBeNull();
    expect(entry.agentVersion).toBeNull();
    expect(entry.nemoclawVersion).toBeNull();
    const rawEntry = entry as unknown as Record<string, unknown>;
    expect(rawEntry.messagingChannels).toBeUndefined();
    expect(rawEntry.messagingChannelConfig).toBeUndefined();
    expect(entry.messaging).toBeUndefined();
    expect(rawEntry.disabledChannels).toBeUndefined();
    expect(entry.hermesToolGateways).toBeUndefined();
    expect(entry.hermesDashboardEnabled).toBeUndefined();
    expect(entry.hermesDashboardPort).toBeUndefined();
    expect(entry.hermesDashboardInternalPort).toBeUndefined();
    expect(entry.hermesDashboardTui).toBeUndefined();
    expect(entry.webSearchEnabled).toBe(false);
    expect(entry.fromDockerfile).toBeNull();
    expect(entry.hermesAuthMethod).toBeNull();
    expect(entry.toolDisclosure).toBe("progressive");
    expect(entry.observabilityEnabled).toBe(false);
    expect(entry.dcodeAutoApprovalMode).toBeUndefined();
  });

  it("carries a durable MCP rebuild manifest into the replacement registry entry", () => {
    const preservedMcpState = {
      bridges: {
        github: {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "demo-mcp-github",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-27T00:00:00.000Z",
        },
      },
    };
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: "nemoclaw-demo:replacement",
      appliedPolicies: [],
      toolDisclosure: "direct",
      plannedMessagingState: undefined,
      preservedMcpState,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.mcp).toBe(preservedMcpState);
    expect(entry.mcp?.bridges.github?.providerName).toBe("demo-mcp-github");
    expect(entry.compatibleEndpointReasoning).toBe("true");
    expect(entry.toolDisclosure).toBe("direct");
  });

  it("carries complete baseline exclusion records through consecutive registrations", () => {
    const baselineExclusions = [
      {
        version: 1 as const,
        agent: "openclaw",
        key: "nous_research",
        digest: "abc",
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
        appliedAgentVersion: null,
      },
    ];
    const fidelity = creationFidelity(null, null, null, false, baselineExclusions);
    const common = {
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false as const, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    };

    const first = buildCreatedSandboxRegistryEntry({ ...common, ...fidelity });
    const secondFidelity = creationFidelity(null, null, null, false, first.baselineExclusions);
    const second = buildCreatedSandboxRegistryEntry({ ...common, ...secondFidelity });

    expect(second.baselineExclusions).toEqual(baselineExclusions);
    expect(second.baselineExclusions).not.toBe(first.baselineExclusions);
    expect(second.baselineExclusions?.[0]).not.toBe(first.baselineExclusions?.[0]);
  });

  it("normalizes invalid preferred inference API values", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "chat",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.preferredInferenceApi).toBeNull();
  });

  it("records an explicit direct tool-disclosure selection", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "compatible-endpoint",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      toolDisclosure: "direct",
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.toolDisclosure).toBe("direct");
  });
});

describe("selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not borrow endpoint credential or NIM metadata from an unrelated session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "other",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://wrong.test/v1",
      credentialEnv: "WRONG_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      nimContainer: "wrong",
    });

    expect(
      selection("demo", "compatible-endpoint", "llama", "openai-completions", "onboard"),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    });
  });

  it("borrows session-scoped metadata only when sandbox provider and model match", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "demo",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
      nimContainer: "nim-right",
    });

    expect(
      selection("demo", "compatible-endpoint", "llama", "openai-completions", "onboard"),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      endpointSource: "onboard",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
      nimContainer: "nim-right",
    });
  });
});

describe("registerCreatedSandbox", () => {
  const runtimeAuthority = {
    schemaVersion: 1 as const,
    kind: "podman" as const,
    ownership: "current-user" as const,
    uid: 1001,
    homeDir: "/home/test",
    configHome: "/home/test/.config",
    runtimeDir: "/run/user/1001",
    socketPath: "/run/user/1001/podman/podman.sock",
  };

  it("persists explicit OpenClaw identity for a matching Portable lifecycle receipt (#9207)", () => {
    const registerSandbox = vi.fn();
    const env = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
    const classifyPortableLifecycleReceipt = vi.fn(() => ({
      kind: "current" as const,
      registryGeneration: "generation-1",
      runtimeAuthority,
    }));

    const entry = registerCreatedSandbox({
      ...createdRegistryEntryInput({ lifecycleGeneration: "generation-1" }),
      portableLifecycle: true,
      environment: env,
      classifyPortableLifecycleReceipt,
      registerSandbox,
    });

    expect(entry.agent).toBe("openclaw");
    expect(classifyPortableLifecycleReceipt).toHaveBeenCalledExactlyOnceWith("demo", { env });
    expect(registerSandbox).toHaveBeenCalledExactlyOnceWith(entry);
  });

  it.each([
    ["missing", { kind: "absent" as const }, "generation-1"],
    ["legacy", { kind: "invalid-or-legacy" as const }, "generation-1"],
    [
      "different generation",
      {
        kind: "current" as const,
        registryGeneration: "generation-2",
        runtimeAuthority,
      },
      "generation-1",
    ],
  ])(
    "rejects a Portable OpenClaw %s receipt before registry mutation (#9207)",
    (_label, receipt, lifecycleGeneration) => {
      const registerSandbox = vi.fn();

      expect(() =>
        registerCreatedSandbox({
          ...createdRegistryEntryInput({ lifecycleGeneration }),
          portableLifecycle: true,
          environment: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
          classifyPortableLifecycleReceipt: () => receipt,
          registerSandbox,
        }),
      ).toThrow(/requires a current lifecycle receipt that matches the registry generation/u);
      expect(registerSandbox).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary OpenClaw registration agent-neutral (#9207)", () => {
    const classifyPortableLifecycleReceipt = vi.fn();

    const entry = registerCreatedSandbox({
      ...createdRegistryEntryInput({ lifecycleGeneration: "generation-1" }),
      environment: {},
      classifyPortableLifecycleReceipt,
      registerSandbox: vi.fn(),
    });

    expect(entry.agent).toBeNull();
    expect(classifyPortableLifecycleReceipt).not.toHaveBeenCalled();
  });

  it("stages an owned registration until onboarding commits the sandbox step", () => {
    const registerSandbox = vi.fn();
    const entry = registerCreatedSandbox({
      ...createdRegistryEntryInput({ lifecycleGeneration: "generation-1" }),
      reservationSessionId: "session-owner",
      registerSandbox,
    });

    expect(registerSandbox).toHaveBeenCalledExactlyOnceWith(entry, undefined, {
      pending: true,
      reservationSessionId: "session-owner",
    });
  });

  it("persists lifecycle identity for a non-OpenClaw agent", () => {
    const agentDefs = requireDist("../agent/defs.js") as typeof import("../agent/defs");
    const registerSandbox = vi.fn();
    const classifyPortableLifecycleReceipt = vi.fn();

    const entry = registerCreatedSandbox({
      sandboxName: "hermes-box",
      inferenceSelection: {
        model: "kimi",
        provider: "hermes-provider",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: agentDefs.loadAgent("hermes"),
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      hermesApiPort: 8642,
      dashboardPort: 0,
      lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
      lifecycleLiveIdentityFingerprint: "d".repeat(64),
      gatewayName: "owner-gateway",
      environment: { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      classifyPortableLifecycleReceipt,
      gatewayPort: 8080,
      registerSandbox,
    });

    expect(entry).toMatchObject({
      agent: "hermes",
      lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
      lifecycleLiveIdentityFingerprint: "d".repeat(64),
      gatewayName: "owner-gateway",
    });
    expect(entry.hermesApiPort).toBe(8642);
    expect(registerSandbox).toHaveBeenCalledExactlyOnceWith(entry);
    expect(entry.agent).toBe("hermes");
    expect(classifyPortableLifecycleReceipt).not.toHaveBeenCalled();
  });

  it("omits unowned API-port state only for schema-5 Hermes registration", () => {
    const agentDefs = requireDist("../agent/defs.js") as typeof import("../agent/defs");
    const entry = registerCreatedSandbox({
      sandboxName: "hermes-portable",
      inferenceSelection: {
        model: "qwen3-vl:4b",
        provider: "ollama-local",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: agentDefs.loadAgent("hermes"),
      agentVersionKnown: true,
      imageTag: null,
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      hermesApiPort: 8642,
      hermesPortableLifecycle: true,
      dashboardPort: 0,
      lifecycleGeneration: "33333333-3333-4333-8333-333333333333",
      lifecycleLiveIdentityFingerprint: "e".repeat(64),
      gatewayName: "owner-gateway",
      gatewayPort: 8080,
      registerSandbox: vi.fn(),
    });

    expect(entry.hermesApiPort).toBeUndefined();
  });

  it("passes the built entry to the supplied registry writer", () => {
    const registerSandbox = vi.fn();
    const hostLocalInferenceReceipt = serializedHostLocalInferenceReceipt("docker");
    const registry = requireDist("../state/registry.js") as typeof import("../state/registry");
    const getSandbox = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "demo",
      hostLocalInferenceReceipt,
    });

    const input = {
      sandboxName: "demo",
      inferenceSelection: {
        model: "llama",
        provider: "openai-compatible",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      },
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: null,
        shared: false,
      },
      openclawImagePluginInstalls: [],
      appliedPolicies: [],
      plannedMessagingState: undefined,
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      registerSandbox,
    } satisfies Parameters<typeof registerCreatedSandbox>[0];
    const entry = registerCreatedSandbox(input);

    expect(registerSandbox).toHaveBeenCalledWith(entry);
    expect(entry.name).toBe("demo");
    expect(entry.openclawImagePluginInstalls).toEqual([]);
    expect(entry.workload).toEqual(input.workload);
    expect(entry.hostLocalInferenceReceipt).toBe(hostLocalInferenceReceipt);
    const clearedEntry = registerCreatedSandbox({
      ...input,
      hostLocalInferenceReceipt: null,
    });
    expect(clearedEntry.hostLocalInferenceReceipt).toBeNull();
    expect(registerSandbox).toHaveBeenLastCalledWith(clearedEntry);
    expect(() =>
      registerCreatedSandbox({
        ...input,
        workload: { ...input.workload, reference: "" },
      }),
    ).toThrow(/workload ownership receipt failed closed validation/u);
    expect(registerSandbox).toHaveBeenCalledTimes(2);
    getSandbox.mockRestore();
  });

  it("inherits exact llama.cpp lifecycle provenance from the pending route reservation", () => {
    const registerSandbox = vi.fn();
    const hostLocalInferenceReceipt = serializedLlamaCppHostLocalInferenceReceipt("docker");
    const hostLocalInferenceProvenance = createSandboxHostLocalInferenceProvenance(
      "original-owner",
      hostLocalInferenceReceipt,
    );
    const registry = requireDist("../state/registry.js") as typeof import("../state/registry");
    const getSandbox = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "demo",
      pendingRouteReservation: true,
      provider: "llama-cpp-local",
      model: "llama-cpp-model",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt,
      hostLocalInferenceProvenance,
    });
    try {
      const entry = registerCreatedSandbox({
        sandboxName: "demo",
        inferenceSelection: {
          model: "llama-cpp-model",
          provider: "llama-cpp-local",
          endpointUrl: "https://inference.local/v1",
          endpointSource: "inference-set",
          credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
        runtimeFields,
        agent: null,
        agentVersionKnown: true,
        imageTag: null,
        appliedPolicies: [],
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        registerSandbox,
      });

      expect(entry.hostLocalInferenceReceipt).toBe(hostLocalInferenceReceipt);
      expect(entry.hostLocalInferenceProvenance).toEqual(hostLocalInferenceProvenance);
      expect(registerSandbox).toHaveBeenCalledExactlyOnceWith(entry);
    } finally {
      getSandbox.mockRestore();
    }
  });

  it("fails before registry mutation for an unknown durable provider identity", () => {
    const registerSandbox = vi.fn();

    expect(() =>
      registerCreatedSandbox({
        sandboxName: "demo",
        inferenceSelection: {
          model: "llama",
          provider: "openai-compatible",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
        runtimeFields: { ...runtimeFields, openshellDriver: "unknown-runtime" },
        agent: null,
        agentVersionKnown: true,
        imageTag: null,
        appliedPolicies: [],
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        registerSandbox,
      }),
    ).toThrow(/not registered/u);
    expect(registerSandbox).not.toHaveBeenCalled();
  });
});
