// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bail: vi.fn(),
  ensureRebuildTargetGatewaySelected: vi.fn(async () => true),
  getMcpPreparationRuntimeSelection: vi.fn(),
  preflightAuthoritativeOnboardRuntime: vi.fn(async (..._args: unknown[]) => false),
  prepareManagedWorkloadRebuildHandoff: vi.fn(),
  prepareSandboxWorkloadSourceFromRebuildHandoff: vi.fn(),
  prepareRebuildTargetConfig: vi.fn(),
  prepareRebuildRecreateOptions: vi.fn(),
  resolveContextWindowForModel: vi.fn(() => 131_072),
  resolveManagedStartupInferenceRoute: vi.fn(),
  stageManagedWorkloadRebuildProfile: vi.fn(),
}));

vi.mock("./rebuild-flow-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-flow-helpers")>()),
  ensureRebuildTargetGatewaySelected: mocks.ensureRebuildTargetGatewaySelected,
}));

vi.mock("./rebuild-mcp-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-mcp-phase")>()),
  getMcpPreparationRuntimeSelection: mocks.getMcpPreparationRuntimeSelection,
}));

vi.mock("../../onboard/workload/rebuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/workload/rebuild")>()),
  prepareManagedWorkloadRebuildHandoff: mocks.prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff:
    mocks.prepareSandboxWorkloadSourceFromRebuildHandoff,
  stageManagedWorkloadRebuildProfile: mocks.stageManagedWorkloadRebuildProfile,
}));

vi.mock("../../onboard/runtime-provider/access", () => ({
  requireRuntimeProviderBundleForSandbox: vi.fn(() => ({ identity: { id: "docker" } })),
}));

vi.mock("../../onboard/workload/runtime", () => ({
  resolveSandboxWorkloadRuntimeCapabilities: vi.fn(() => ({})),
}));

vi.mock("./rebuild-target-preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-target-preflight")>()),
  hydrateMessagingConfigForRebuild: vi.fn(),
  preflightAuthoritativeOnboardRuntime: mocks.preflightAuthoritativeOnboardRuntime,
  prepareRebuildRecreateOptions: mocks.prepareRebuildRecreateOptions,
  prepareRebuildTargetConfig: mocks.prepareRebuildTargetConfig,
  stageRebuildHermesDashboardConfig: vi.fn(() => true),
}));

vi.mock("./rebuild-messaging-phase", () => ({
  stageRebuildMessagingPlanOrBail: vi.fn(async () => null),
}));

vi.mock("./rebuild-messaging-conflict-preflight", () => ({
  preflightRebuildMessagingConflicts: vi.fn(async () => undefined),
}));

import { managedRebuildProfileDependencies } from "./agents/managed-workload-rebuild-profile";
import {
  evaluateOnboardReadinessAdmission,
  ONBOARD_REQUIRED_CAPABILITY_IDS,
} from "../../readiness/onboard-admission";
import type { ReadinessCapability, SystemReadinessReport } from "../../readiness/types";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { prepareRebuildTargetPreflights } from "./rebuild-preflight-target-phase";

describe("prepareRebuildTargetPreflights", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpPreparationRuntimeSelection.mockReturnValue({
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    });
    mocks.prepareManagedWorkloadRebuildHandoff.mockResolvedValue(null);
    mocks.preflightAuthoritativeOnboardRuntime.mockResolvedValue(false);
  });

  async function prepareN1xTarget(
    endpointSource: "onboard" | "inference-set" | null,
    mcp: { bridges: Record<string, { server: string }> } | null = null,
    provider = "vllm-local",
    model = "nvidia/Qwen3.6-35B-A3B-NVFP4",
    nimContainer: string | null = null,
    accepted = endpointSource === null,
    entryOverrides: {
      endpointUrl?: string | null;
      hostLocalInferenceReceipt?: string | null;
    } = {},
  ) {
    const resumeConfig = {
      provider,
      model,
      preferredInferenceApi: "openai-completions",
      pinEndpoint: true,
      endpointUrl: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      registryInferenceRoute: null,
    };
    mocks.prepareRebuildTargetConfig.mockReturnValue({
      agentDefinition: {},
      resumeConfig,
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    });
    mocks.prepareRebuildRecreateOptions.mockReturnValue({
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    });

    await prepareRebuildTargetPreflights({
      sandboxName: "my-assistant",
      sandboxEntry: {
        name: "my-assistant",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        openshellDriver: "docker",
        provider: resumeConfig.provider,
        model: resumeConfig.model,
        endpointUrl: endpointSource === null ? null : "http://host.openshell.internal:8000/v1",
        endpointSource,
        nimContainer,
        ...(endpointSource === null && accepted
          ? {
              deferredN1xManagedVllmAccepted: true,
            }
          : {}),
        mcp,
        ...entryOverrides,
      } as never,
      rebuildAgent: "openclaw",
      autoYes: true,
      log: vi.fn(),
      bail: mocks.bail as never,
    });
    return mocks.preflightAuthoritativeOnboardRuntime.mock.calls[0]?.[2] as
      | RebuildRecreateOnboardOpts
      | undefined;
  }

  it("resolves the Ollama context window through target preparation", async () => {
    const catalogHandoff = {
      agent: "openclaw",
      previousProfile: {
        inference: { model: "gpt-5.4", upstreamProvider: "openai-api" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
      },
    };
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "ollama-local",
        model: "qwen3.5:9b",
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        registryInferenceRoute: null,
      },
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    };
    const recreateOptions = {
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    };
    mocks.prepareManagedWorkloadRebuildHandoff.mockResolvedValue(catalogHandoff);
    mocks.prepareRebuildTargetConfig.mockReturnValue(targetConfig);
    mocks.prepareRebuildRecreateOptions.mockReturnValue(recreateOptions);
    mocks.stageManagedWorkloadRebuildProfile.mockReturnValue({ providerId: "docker" });
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockImplementation(
      mocks.resolveContextWindowForModel,
    );
    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockImplementation(mocks.resolveManagedStartupInferenceRoute);
    mocks.resolveManagedStartupInferenceRoute.mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/qwen3.5:9b",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: {},
    });

    await expect(
      prepareRebuildTargetPreflights({
        sandboxName: "alpha",
        sandboxEntry: {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        } as never,
        rebuildAgent: "openclaw",
        autoYes: true,
        log: vi.fn(),
        bail: mocks.bail as never,
      }),
    ).resolves.toBeNull();
    expect(mocks.resolveContextWindowForModel).toHaveBeenCalledWith("ollama-local", "qwen3.5:9b");
  });

  it("passes legacy Station authority from the source registry row into rebuild readiness (#10370)", async () => {
    const resumeConfig = {
      provider: "ollama-local",
      model: "llama3.2:1b",
      preferredInferenceApi: "openai-completions",
      endpointUrl: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      registryInferenceRoute: null,
    };
    mocks.prepareRebuildTargetConfig.mockReturnValue({
      agentDefinition: {},
      resumeConfig,
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    });
    mocks.prepareRebuildRecreateOptions.mockReturnValue({
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    });

    await prepareRebuildTargetPreflights({
      sandboxName: "legacy-hermes",
      sandboxEntry: {
        name: "legacy-hermes",
        agent: "hermes",
        nemoclawVersion: "v0.0.83",
        fromDockerfile: null,
        gatewayName: "nemoclaw",
        openshellDriver: "docker",
        provider: resumeConfig.provider,
        model: resumeConfig.model,
      } as never,
      rebuildAgent: "hermes",
      autoYes: true,
      log: vi.fn(),
      bail: mocks.bail as never,
    });

    expect(mocks.preflightAuthoritativeOnboardRuntime.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ allowLegacyDgxStationQualification: true }),
    );
  });

  it("keeps unrelated readiness blockers ahead of legacy Hermes recovery effects (#10375)", async () => {
    const resumeConfig = {
      provider: "ollama-local",
      model: "llama3.2:1b",
      preferredInferenceApi: "openai-completions",
      endpointUrl: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      registryInferenceRoute: null,
    };
    mocks.prepareRebuildTargetConfig.mockReturnValue({
      agentDefinition: {},
      resumeConfig,
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    });
    mocks.prepareRebuildRecreateOptions.mockReturnValue({
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      targetGatewayPort: 8080,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    });
    const capabilities: ReadinessCapability[] = [
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaGpuAvailable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaContainerToolkitAvailable,
      ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaCdiHealthy,
      ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported,
    ].map((id): ReadinessCapability => ({
      id,
      state: id === ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported ? "absent" : "present",
    }));
    capabilities.push({ id: "host.platform.dgx_station", state: "absent" });
    const readinessReport = {
      schemaVersion: "1.1.0",
      status: "incompatible",
      exitCode: 2,
      mutated: false,
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        observedAt: "2026-09-08T00:00:00.000Z",
      },
      observations: [],
      capabilities,
      qualifications: [],
      findings: [
        {
          id: "host.platform.dgx_station_unqualified",
          severity: "blocking",
          summary: "DGX Station is not qualified",
        },
        {
          id: "host.example.blocked",
          severity: "blocking",
          summary: "Another readiness blocker remains",
        },
      ],
      evidence: [],
    } satisfies SystemReadinessReport;
    mocks.preflightAuthoritativeOnboardRuntime.mockImplementation(
      async (_sandboxName, _resumeConfig, recreateOptions) =>
        evaluateOnboardReadinessAdmission(readinessReport, {
          explicitlyOptedOutGpuPassthrough: false,
          allowUnsupportedRuntime: false,
          allowStorageRemediation: false,
          allowLegacyDgxStationQualification:
            (recreateOptions as RebuildRecreateOnboardOpts).allowLegacyDgxStationQualification ===
            true,
        }).admitted,
    );

    await expect(
      prepareRebuildTargetPreflights({
        sandboxName: "legacy-hermes-blocked",
        sandboxEntry: {
          name: "legacy-hermes-blocked",
          agent: "hermes",
          nemoclawVersion: "v0.0.83",
          fromDockerfile: null,
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
          provider: resumeConfig.provider,
          model: resumeConfig.model,
        } as never,
        rebuildAgent: "hermes",
        autoYes: true,
        log: vi.fn(),
        bail: mocks.bail as never,
      }),
    ).resolves.toBeNull();

    expect(mocks.preflightAuthoritativeOnboardRuntime).toHaveBeenCalledWith(
      "legacy-hermes-blocked",
      resumeConfig,
      expect.objectContaining({ allowLegacyDgxStationQualification: true }),
      expect.any(Function),
      {},
    );
    expect(mocks.ensureRebuildTargetGatewaySelected).not.toHaveBeenCalled();
  });

  it("stops managed rebuild when its base-image override cannot be honored (#11138)", async () => {
    mocks.prepareRebuildTargetConfig.mockReturnValue({
      agentDefinition: {},
      resumeConfig: {
        provider: "nvidia",
        model: "moonshotai/kimi-k2.6",
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        registryInferenceRoute: null,
      },
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    });
    mocks.prepareRebuildRecreateOptions.mockReturnValue({
      controlUiPort: 19_189,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    });
    mocks.prepareManagedWorkloadRebuildHandoff.mockRejectedValue(
      new Error("'NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF' is set"),
    );

    await expect(
      prepareRebuildTargetPreflights({
        sandboxName: "hermes-managed",
        sandboxEntry: {
          name: "hermes-managed",
          agent: "hermes",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        } as never,
        rebuildAgent: "hermes",
        autoYes: true,
        log: vi.fn(),
        bail: mocks.bail as never,
      }),
    ).resolves.toBeNull();
    expect(mocks.bail).toHaveBeenCalledWith("'NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF' is set");
    expect(mocks.prepareSandboxWorkloadSourceFromRebuildHandoff).not.toHaveBeenCalled();
    expect(mocks.preflightAuthoritativeOnboardRuntime).not.toHaveBeenCalled();
  });

  it("passes exact legacy N1x intent into authoritative readiness (#9292)", async () => {
    const readinessOptions = await prepareN1xTarget("onboard");

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("passes normalized N1x Express intent into readiness (#10959)", async () => {
    const readinessOptions = await prepareN1xTarget(null);

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("passes explicit v0.0.119 recovery intent into readiness (#10959)", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
    const readinessOptions = await prepareN1xTarget(null, null, undefined, undefined, null, false);

    expect(readinessOptions).toEqual(
      expect.objectContaining({
        allowDeferredN1xManagedVllm: true,
        reinstallDeferredN1xManagedVllm: true,
      }),
    );
  });

  it.each([
    ["a recorded endpoint", null, null, { endpointUrl: "http://host.openshell.internal:8000/v1" }],
    ["another endpoint source", "inference-set", null, {}],
    ["a NIM container", null, "nemoclaw-nim", {}],
    ["a malformed receipt", null, null, { hostLocalInferenceReceipt: "invalid" }],
  ] as const)(
    "withholds explicit recovery for %s (#10959)",
    async (_case, source, nim, overrides) => {
      vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
      const readinessOptions = await prepareN1xTarget(
        source,
        null,
        undefined,
        undefined,
        nim,
        false,
        overrides,
      );

      expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
    },
  );

  it("passes recorded Ollama intent into authoritative readiness (#11041)", async () => {
    const readinessOptions = await prepareN1xTarget("onboard", null, "ollama-local", "qwen3.5:9b");

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("withholds recorded Local NIM intent from authoritative readiness (#11041)", async () => {
    const readinessOptions = await prepareN1xTarget(
      "onboard",
      null,
      "vllm-local",
      "nvidia/Qwen3.6-35B-A3B-NVFP4",
      "nemoclaw-nim",
    );

    expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
  });

  it("withholds N1x intent for a mismatched endpoint source (#9292)", async () => {
    const readinessOptions = await prepareN1xTarget("inference-set");

    expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
  });

  it("freezes one MCP runtime target before authoritative readiness (#10514)", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };
    mocks.getMcpPreparationRuntimeSelection.mockReturnValue(runtimeSelection);

    const readinessOptions = await prepareN1xTarget("onboard", {
      bridges: { github: { server: "github" } },
    });

    expect(mocks.getMcpPreparationRuntimeSelection).toHaveBeenCalledOnce();
    expect(readinessOptions?.runtimeSelection).toBe(runtimeSelection);
  });
});
