// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { missing, reconcile } from "./extra-provider-reconciliation.test-fixtures";
import { prepareSandboxCreatePlan } from "./sandbox-create-plan";
import type { SandboxGpuCreateConfig } from "./sandbox-gpu-create";

const sandboxGpuConfig: SandboxGpuCreateConfig = {
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
};

function providerArgs(args: string[]): string[] {
  return args
    .map((arg, index) => (arg === "--provider" ? args[index + 1] : null))
    .filter((value): value is string => value !== null);
}

function buildPlan(
  extraProviders: readonly string[] = ["brave-search", "custom-provider", "brave-search"],
) {
  return prepareSandboxCreatePlan({
    basePolicyPath: "/repo/policy.yaml",
    buildCtx: "/tmp/nemoclaw-build-1",
    sandboxName: "sandbox",
    channels: [],
    enabledChannels: [],
    disabledChannelNames: new Set(),
    messagingTokenDefs: [],
    reusableMessagingChannels: [],
    reusableMessagingProviders: [],
    extraProviders,
    hermesToolGateways: [],
    sandboxGpuConfig,
    dockerDriverGateway: true,
    appendResourceFlags: vi.fn(),
    runProviderPreDeleteCleanup: vi.fn(),
    upsertMessagingProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: () => null,
    getHermesToolGatewayProviderName: vi.fn(),
    deps: {
      resolveDockerGpuSandboxCreatePlan: vi.fn(() => ({
        useDockerGpuPatch: false,
        logMessage: null,
      })),
      prepareInitialSandboxCreatePolicy: vi.fn(() => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      })),
      buildSandboxGpuCreateArgs: vi.fn(() => []),
    },
  });
}

describe("prepareSandboxCreatePlan extra providers", () => {
  it("keeps reconciled extra providers stable across retry create plans (#6501)", () => {
    const reconciledExtraProviders = reconcile(
      ["brave-search", "tavily-search", "custom-provider", "brave-search"],
      {
        "tavily-search": missing("tavily-search"),
      },
    );
    const firstProviders = providerArgs(buildPlan(reconciledExtraProviders).createArgs);
    const retryProviders = providerArgs(buildPlan(reconciledExtraProviders).createArgs);

    expect(reconciledExtraProviders).toEqual(["brave-search", "custom-provider", "brave-search"]);
    expect(firstProviders).toEqual(["brave-search", "custom-provider"]);
    expect(retryProviders).toEqual(firstProviders);
  });
});
