// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildCreatedSandboxRegistryEntry,
  registerCreatedSandbox,
} from "../../../dist/lib/onboard/sandbox-registration";

const runtimeFields = {
  gpuEnabled: true,
  hostGpuDetected: true,
  sandboxGpuEnabled: true,
  sandboxGpuMode: "auto",
  sandboxGpuDevice: null,
  openshellDriver: "docker",
  openshellVersion: "0.1.2",
};

describe("buildCreatedSandboxRegistryEntry", () => {
  it("records the final created sandbox metadata with configured messaging channels", () => {
    const plannedMessagingState = {
      schemaVersion: 1 as const,
      plan: { sandboxName: "demo" },
    };
    const messagingChannelConfig = { DISCORD_ALLOWED_USER_IDS: "123" };

    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      model: "llama",
      provider: "openai-compatible",
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: "nemoclaw-demo:123",
      providerCredentialHashes: { SLACK_BOT_TOKEN: "hash-slack-bot" },
      appliedPolicies: ["discord", "slack"],
      configuredMessagingChannels: ["slack", "discord", "slack"],
      activeMessagingChannels: ["discord"],
      messagingChannelConfig,
      plannedMessagingState: plannedMessagingState as any,
      disabledChannels: ["telegram"],
      hermesToolGateways: ["filesystem"],
      hermesDashboardState: {
        enabled: true,
        config: { enabled: true, port: 18790, internalPort: 19123, tuiEnabled: true },
      },
      dashboardPort: 18789,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    expect(entry).toMatchObject({
      name: "demo",
      model: "llama",
      provider: "openai-compatible",
      imageTag: "nemoclaw-demo:123",
      providerCredentialHashes: { SLACK_BOT_TOKEN: "hash-slack-bot" },
      policies: ["discord", "slack"],
      messagingChannels: ["slack", "discord"],
      messagingChannelConfig,
      disabledChannels: ["telegram"],
      hermesToolGateways: ["filesystem"],
      hermesDashboardEnabled: true,
      hermesDashboardPort: 18790,
      hermesDashboardInternalPort: 19123,
      hermesDashboardTui: true,
      dashboardPort: 18789,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      gpuEnabled: true,
      openshellDriver: "docker",
      openshellVersion: "0.1.2",
    });
    expect(entry.agent).toBeNull();
    expect(entry.messaging).toBe(plannedMessagingState);
  });

  it("uses active channels and skips stale messaging plans when no configured channel set exists", () => {
    const entry = buildCreatedSandboxRegistryEntry({
      sandboxName: "demo",
      model: "",
      provider: "",
      runtimeFields,
      agent: null,
      agentVersionKnown: false,
      imageTag: null,
      providerCredentialHashes: {},
      appliedPolicies: [],
      configuredMessagingChannels: null,
      activeMessagingChannels: ["telegram"],
      messagingChannelConfig: null,
      plannedMessagingState: {
        schemaVersion: 1 as const,
        plan: { sandboxName: "other" },
      } as any,
      disabledChannels: [],
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });

    expect(entry.model).toBeNull();
    expect(entry.provider).toBeNull();
    expect(entry.messagingChannels).toEqual(["telegram"]);
    expect(entry.messagingChannelConfig).toBeUndefined();
    expect(entry.messaging).toBeUndefined();
    expect(entry.disabledChannels).toBeUndefined();
    expect(entry.hermesToolGateways).toBeUndefined();
    expect(entry.hermesDashboardEnabled).toBeUndefined();
    expect(entry.hermesDashboardPort).toBeUndefined();
    expect(entry.hermesDashboardInternalPort).toBeUndefined();
    expect(entry.hermesDashboardTui).toBeUndefined();
  });
});

describe("registerCreatedSandbox", () => {
  it("passes the built entry to the supplied registry writer", () => {
    const registerSandbox = vi.fn();

    const entry = registerCreatedSandbox({
      sandboxName: "demo",
      model: "llama",
      provider: "openai-compatible",
      runtimeFields,
      agent: null,
      agentVersionKnown: true,
      imageTag: null,
      providerCredentialHashes: {},
      appliedPolicies: [],
      configuredMessagingChannels: null,
      activeMessagingChannels: [],
      messagingChannelConfig: undefined,
      plannedMessagingState: undefined,
      disabledChannels: [],
      hermesToolGateways: [],
      hermesDashboardState: { enabled: false, config: null },
      dashboardPort: 18789,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      registerSandbox,
    });

    expect(registerSandbox).toHaveBeenCalledWith(entry);
    expect(entry.name).toBe("demo");
  });
});
