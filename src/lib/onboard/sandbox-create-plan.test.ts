// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { prepareSandboxCreatePlan } from "./sandbox-create-plan";
import type { SandboxGpuCreateConfig } from "./sandbox-gpu-create";

const sandboxGpuConfig: SandboxGpuCreateConfig = {
  sandboxGpuEnabled: true,
  sandboxGpuDevice: "nvidia.com/gpu=0",
};

const channels = [
  {
    name: "telegram",
    envKey: "TELEGRAM_BOT_TOKEN",
    label: "Telegram",
    description: "Telegram",
    help: "Telegram",
  },
  {
    name: "slack",
    envKey: "SLACK_BOT_TOKEN",
    appTokenEnvKey: "SLACK_APP_TOKEN",
    label: "Slack",
    description: "Slack",
    help: "Slack",
  },
  {
    name: "whatsapp",
    loginMethod: "in-sandbox-qr" as const,
    label: "WhatsApp",
    description: "WhatsApp",
    help: "WhatsApp",
  },
];

describe("prepareSandboxCreatePlan", () => {
  it("builds create args, policy, providers, and active channels in onboard order", () => {
    const events: string[] = [];
    const appendResourceFlags = vi.fn((args: string[]) => {
      events.push("resources");
      args.push("--memory", "16g");
    });
    const runProviderPreDeleteCleanup = vi.fn(() => events.push("cleanup"));
    const upsertMessagingProviders = vi.fn(() => {
      events.push("upsert");
      return ["sandbox-telegram-bridge", "sandbox-slack-bridge"];
    });
    const prepareInitialSandboxCreatePolicy = vi.fn(() => ({
      policyPath: "/tmp/policy.yaml",
      appliedPresets: ["telegram"],
      cleanup: vi.fn(),
    }));

    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["telegram", "whatsapp"],
      disabledChannelNames: new Set(),
      messagingTokenDefs: [
        { envKey: "TELEGRAM_BOT_TOKEN", token: "telegram-token" },
        { envKey: "SLACK_APP_TOKEN", token: "slack-app-token" },
        { envKey: "SLACK_BOT_TOKEN", token: "slack-bot-token" },
      ],
      reusableMessagingChannels: ["discord"],
      reusableMessagingProviders: ["sandbox-existing-discord"],
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      dockerDriverGateway: true,
      appendResourceFlags,
      runProviderPreDeleteCleanup,
      upsertMessagingProviders,
      getMessagingChannelForEnvKey: (envKey) =>
        envKey === "TELEGRAM_BOT_TOKEN"
          ? "telegram"
          : envKey === "SLACK_BOT_TOKEN"
            ? "slack"
            : null,
      getHermesToolGatewayProviderName: (sandboxName) => `${sandboxName}-hermes-tools`,
      agentName: "langchain-deepagents-code",
      deps: {
        resolveDockerGpuSandboxCreatePlan: vi.fn(() => ({
          useDockerGpuPatch: false,
          logMessage: "gpu note",
        })),
        prepareInitialSandboxCreatePolicy,
        buildSandboxGpuCreateArgs: vi.fn(() => ["--gpu", "--gpu-device", "nvidia.com/gpu=0"]),
      },
    });

    expect(result.activeMessagingChannels).toEqual(["telegram", "slack", "discord", "whatsapp"]);
    expect(prepareInitialSandboxCreatePolicy).toHaveBeenCalledWith(
      "/repo/policy.yaml",
      ["telegram", "slack", "discord", "whatsapp"],
      {
        directGpu: true,
        dockerGpuPatch: false,
        additionalPresets: ["github"],
        agentName: "langchain-deepagents-code",
      },
    );
    expect(result.createArgs).toEqual([
      "--from",
      "/tmp/nemoclaw-build-1/Dockerfile",
      "--name",
      "sandbox",
      "--policy",
      "/tmp/policy.yaml",
      "--gpu",
      "--gpu-device",
      "nvidia.com/gpu=0",
      "--memory",
      "16g",
      "--provider",
      "sandbox-telegram-bridge",
      "--provider",
      "sandbox-slack-bridge",
      "--provider",
      "sandbox-existing-discord",
      "--provider",
      "sandbox-hermes-tools",
    ]);
    expect(result.messagingProviders).toEqual([
      "sandbox-telegram-bridge",
      "sandbox-slack-bridge",
      "sandbox-existing-discord",
    ]);
    expect(result.sandboxGpuLogMessage).toBe("gpu note");
    expect(events).toEqual(["resources", "cleanup", "upsert"]);
  });

  it("filters disabled channels from token, reusable, and provider sources", () => {
    const upsertMessagingProviders = vi.fn(() => [
      "sandbox-telegram-bridge",
      "sandbox-slack-bridge",
    ]);

    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["telegram", "slack", "whatsapp"],
      disabledChannelNames: new Set(["slack"]),
      messagingTokenDefs: [
        { name: "sandbox-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "telegram" },
        { name: "sandbox-slack-bridge", envKey: "SLACK_BOT_TOKEN", token: "slack" },
      ],
      reusableMessagingChannels: ["slack", "whatsapp"],
      reusableMessagingProviders: ["sandbox-slack-bridge", "sandbox-existing-whatsapp"],
      hermesToolGateways: [],
      sandboxGpuConfig,
      dockerDriverGateway: true,
      appendResourceFlags: vi.fn(),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders,
      getMessagingChannelForEnvKey: (envKey) =>
        envKey === "TELEGRAM_BOT_TOKEN"
          ? "telegram"
          : envKey === "SLACK_BOT_TOKEN"
            ? "slack"
            : null,
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

    expect(upsertMessagingProviders).toHaveBeenCalledWith(
      [{ name: "sandbox-telegram-bridge", envKey: "TELEGRAM_BOT_TOKEN", token: "telegram" }],
      { replaceExisting: true },
    );
    expect(result.activeMessagingChannels).toEqual(["telegram", "whatsapp"]);
    expect(result.messagingProviders).toEqual([
      "sandbox-telegram-bridge",
      "sandbox-existing-whatsapp",
    ]);
    expect(result.createArgs).toContain("sandbox-telegram-bridge");
    expect(result.createArgs).not.toContain("sandbox-slack-bridge");
  });

  it("does not activate slack from an app token alone and suppresses --gpu for Docker GPU patching", () => {
    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["slack", "whatsapp"],
      disabledChannelNames: new Set(["whatsapp"]),
      messagingTokenDefs: [{ envKey: "SLACK_APP_TOKEN", token: "slack-app-token" }],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
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
          useDockerGpuPatch: true,
          logMessage: null,
        })),
        prepareInitialSandboxCreatePolicy: vi.fn(() => ({
          policyPath: "/tmp/policy.yaml",
          appliedPresets: [],
        })),
        buildSandboxGpuCreateArgs: vi.fn(() => []),
      },
    });

    expect(result.activeMessagingChannels).toEqual([]);
    expect(result.useDockerGpuPatch).toBe(true);
    expect(result.createArgs).toEqual([
      "--from",
      "/tmp/nemoclaw-build-1/Dockerfile",
      "--name",
      "sandbox",
      "--policy",
      "/tmp/policy.yaml",
    ]);
  });
});
