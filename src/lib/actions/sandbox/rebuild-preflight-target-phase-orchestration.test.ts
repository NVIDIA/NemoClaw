// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bail: vi.fn(),
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
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { prepareRebuildTargetPreflights } from "./rebuild-preflight-target-phase";

describe("prepareRebuildTargetPreflights", () => {
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
    endpointSource: "onboard" | "inference-set",
    mcp: { bridges: Record<string, { server: string }> } | null = null,
    provider = "vllm-local",
    model = "nvidia/Qwen3.6-35B-A3B-NVFP4",
    nimContainer: string | null = null,
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
        endpointUrl: "http://host.openshell.internal:8000/v1",
        endpointSource,
        nimContainer,
        mcp,
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

  it("passes exact legacy N1x intent into authoritative readiness (#9292)", async () => {
    const readinessOptions = await prepareN1xTarget("onboard");

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

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
