// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bail: vi.fn(),
  prepareManagedWorkloadRebuildHandoff: vi.fn(),
  prepareSandboxWorkloadSourceFromRebuildHandoff: vi.fn(),
  prepareRebuildTargetConfig: vi.fn(),
  prepareRebuildRecreateOptions: vi.fn(),
  resolveContextWindowForModel: vi.fn(() => 131_072),
  resolveManagedStartupInferenceRoute: vi.fn(),
  stageManagedWorkloadRebuildProfile: vi.fn(),
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
  preflightAuthoritativeOnboardRuntime: vi.fn(async () => false),
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
import { prepareRebuildTargetPreflights } from "./rebuild-preflight-target-phase";

describe("managed workload rebuild context-window preflight", () => {
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
});
