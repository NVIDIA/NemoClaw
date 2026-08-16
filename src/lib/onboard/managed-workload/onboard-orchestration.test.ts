// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { prepareOnboardSandboxWorkloadLaunch } from "./onboard-orchestration";

describe("managed workload onboard orchestration", () => {
  it("resolves final-image patch metadata after managed build-context staging", async () => {
    const resolutionMetadata = { key: "published-dcode-base" };
    let staged = false;
    const resolvePatchInput = vi.fn(() => {
      expect(staged).toBe(true);
      return { preResolvedBaseImageMetadata: resolutionMetadata } as never;
    });
    const resolveSandboxBuildPatch = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.preResolvedBaseImageMetadata).toBe(resolutionMetadata);
      expect(input.stagedDockerfile).toBe("/tmp/nemoclaw-staged-context/Dockerfile");
      return { buildId: "dcode-build", dashboardRemoteBindPrepared: false };
    });
    const materializeSandboxCreatePlan = vi.fn(() => ({
      activeMessagingChannels: [],
      compatibilityPolicyPath: null,
      createArgs: [
        "--from",
        "/tmp/nemoclaw-staged-context/Dockerfile",
        "--name",
        "dcode",
        "--policy",
        "/tmp/nemoclaw-policy.yaml",
      ],
      gpuRoutePlan: "none",
      initialSandboxPolicy: {
        appliedPresets: [],
        policyPath: "/tmp/nemoclaw-policy.yaml",
      },
      messagingProviders: [],
      policyTier: null,
      sandboxGpuLogMessage: null,
    }));

    await prepareOnboardSandboxWorkloadLaunch({
      runtime: {
        runtimeProvider: null,
        ensurePreparedWorkload: vi.fn(),
        ensurePreparedProfile: vi.fn(),
      },
      workload: {
        source: {
          kind: "legacy-dockerfile",
          dockerfilePath: "agents/langchain-deepagents-code/Dockerfile",
          reason: "runtime-unsupported",
        },
        release: "v0.0.0",
        fallbackDiagnostic: null,
      },
      legacy: {
        preparedBuildContext: null,
        agent: {
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
        },
        fromDockerfile: null,
        createAgentSandbox: () => {
          staged = true;
          return {
            buildCtx: "/tmp/nemoclaw-staged-context",
            stagedDockerfile: "/tmp/nemoclaw-staged-context/Dockerfile",
            baseImageResolutionMetadata: resolutionMetadata,
          };
        },
        resolvePatchInput,
      },
      plan: {
        intent: {},
        rebindMessagingTokenDefs: async () => [],
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(() => "unused"),
        discloseInitialSandboxPolicy: vi.fn(),
      },
      launchInput: {
        agent: null,
        chatUiUrl: "http://127.0.0.1:18789",
        sandboxName: "dcode",
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesDashboardState: {},
        manageDashboard: false,
        openshellShellCommand: () => "openshell sandbox create",
      },
      plannedMessagingPlan: null,
      gpu: {
        provider: "compatible-endpoint",
        config: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        dockerDriverGateway: false,
        gatewayPort: 8080,
      },
      dependencies: {
        materializeSandboxCreatePlan,
        prepareSandboxBuildPatchConfig: vi.fn(() => ({
          messagingChannelConfig: null,
        })),
        resolveSandboxBuildPatch,
      },
    } as unknown as Parameters<typeof prepareOnboardSandboxWorkloadLaunch>[0]);

    expect(resolvePatchInput).toHaveBeenCalledOnce();
    expect(resolveSandboxBuildPatch).toHaveBeenCalledOnce();
  });
});
