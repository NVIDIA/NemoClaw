// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { MessagingTokenDef } from "./messaging-prep";
import {
  materializeSandboxCreatePlan,
  prepareSandboxCreatePlan,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-plan";
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

function expectCredentialBindingFailure({
  expectedMessage,
  materializedTokenDefs,
  plannedTokenDef,
}: {
  expectedMessage: string;
  materializedTokenDefs: MessagingTokenDef[];
  plannedTokenDef: MessagingTokenDef;
}): void {
  const intent = resolveSandboxCreateIntent({
    basePolicyPath: "/repo/policy.yaml",
    sandboxName: "sandbox",
    channels,
    enabledChannels: ["telegram"],
    disabledChannelNames: new Set(),
    messagingProviderRequests: resolveSandboxCreateMessagingProviderRequests(
      [plannedTokenDef],
      () => "telegram",
    ),
    primaryMessagingCredentialEnvKeys: [plannedTokenDef.envKey],
    reusableMessagingChannels: [],
    reusableMessagingProviders: [],
    hermesToolGateways: [],
    sandboxGpuConfig,
    gpuCreateArgs: [],
    useDockerGpuPatch: false,
    sandboxGpuLogMessage: null,
    policyTier: null,
  });
  const preparePolicy = vi.fn(() => ({ policyPath: "/tmp/policy.yaml", appliedPresets: [] }));
  const appendResources = vi.fn();
  const cleanupProviders = vi.fn();
  const upsertProviders = vi.fn(() => []);

  expect(() =>
    materializeSandboxCreatePlan({
      intent,
      buildCtx: "/tmp/nemoclaw-build-1",
      messagingTokenDefs: materializedTokenDefs,
      prepareInitialSandboxCreatePolicy: preparePolicy,
      appendResourceFlags: appendResources,
      runProviderPreDeleteCleanup: cleanupProviders,
      upsertMessagingProviders: upsertProviders,
      getHermesToolGatewayProviderName: vi.fn(),
    }),
  ).toThrow(expectedMessage);
  expect(preparePolicy).not.toHaveBeenCalled();
  expect(appendResources).not.toHaveBeenCalled();
  expect(cleanupProviders).not.toHaveBeenCalled();
  expect(upsertProviders).not.toHaveBeenCalled();
}

describe("resolveSandboxCreateIntent", () => {
  it("turns credential-bearing inputs into secretless provider requests", () => {
    const requests = resolveSandboxCreateMessagingProviderRequests(
      [
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "telegram-super-secret",
        },
        {
          name: "sandbox-brave-search",
          envKey: "BRAVE_API_KEY",
          token: null,
          providerType: "brave-search",
        },
      ],
      (envKey) => (envKey === "TELEGRAM_BOT_TOKEN" ? "telegram" : null),
    );

    expect(requests).toEqual([
      {
        name: "sandbox-telegram-bridge",
        envKey: "TELEGRAM_BOT_TOKEN",
        credentialConfigured: true,
        channel: "telegram",
      },
      {
        name: "sandbox-brave-search",
        envKey: "BRAVE_API_KEY",
        providerType: "brave-search",
        credentialConfigured: false,
        channel: null,
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("telegram-super-secret");
  });

  it("resolves deterministic serializable intent without execution artifacts", () => {
    const input = {
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["telegram", "slack", "whatsapp"],
      disabledChannelNames: new Set(["slack"]),
      messagingProviderRequests: [
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          credentialConfigured: true,
          channel: "telegram",
        },
        {
          name: "sandbox-slack-bridge",
          envKey: "SLACK_BOT_TOKEN",
          credentialConfigured: true,
          channel: "slack",
        },
      ],
      primaryMessagingCredentialEnvKeys: ["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN"],
      reusableMessagingChannels: ["discord", "slack"],
      reusableMessagingProviders: ["sandbox-existing-discord", "sandbox-slack-bridge"],
      extraProviders: ["custom-provider", "custom-provider", ""],
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      gpuCreateArgs: ["--gpu", "--gpu-device", "nvidia.com/gpu=0"],
      useDockerGpuPatch: false,
      sandboxGpuLogMessage: "gpu note",
      agentName: "hermes",
      policyTier: "balanced",
    };

    const first = resolveSandboxCreateIntent(input);
    const second = resolveSandboxCreateIntent(input);

    expect(first).toEqual(second);
    expect(first.activeMessagingChannels).toEqual(["telegram", "discord", "whatsapp"]);
    expect(first.messagingProviderRequests.map(({ name }) => name)).toEqual([
      "sandbox-telegram-bridge",
      "sandbox-slack-bridge",
    ]);
    expect(first.reusableMessagingProviders).toEqual(["sandbox-existing-discord"]);
    expect(first.extraProviders).toEqual(["custom-provider"]);
    expect(first.policy).toEqual({
      basePolicyPath: "/repo/policy.yaml",
      activeMessagingChannels: ["telegram", "discord", "whatsapp"],
      options: {
        directGpu: true,
        dockerGpuPatch: false,
        additionalPresets: ["github"],
        agentName: "hermes",
        policyTier: "balanced",
      },
    });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("/tmp/");
  });

  it("materializes policy and provider effects after resolving intent", () => {
    const tokenDefs = [
      {
        name: "sandbox-telegram-bridge",
        envKey: "TELEGRAM_BOT_TOKEN",
        token: "telegram-super-secret",
      },
    ];
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["telegram"],
      disabledChannelNames: new Set(),
      messagingProviderRequests: resolveSandboxCreateMessagingProviderRequests(
        tokenDefs,
        () => "telegram",
      ),
      primaryMessagingCredentialEnvKeys: ["TELEGRAM_BOT_TOKEN"],
      reusableMessagingChannels: [],
      reusableMessagingProviders: ["sandbox-existing-discord"],
      extraProviders: ["custom-provider"],
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      gpuCreateArgs: ["--gpu"],
      useDockerGpuPatch: false,
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: "balanced",
    });
    const serializedIntent = JSON.stringify(intent);
    const events: string[] = [];

    const result = materializeSandboxCreatePlan({
      intent,
      buildCtx: "/tmp/nemoclaw-build-1",
      messagingTokenDefs: tokenDefs,
      prepareInitialSandboxCreatePolicy: vi.fn(() => {
        events.push("policy");
        return { policyPath: "/tmp/policy.yaml", appliedPresets: ["telegram"] };
      }),
      appendResourceFlags: (args) => {
        events.push("resources");
        args.push("--memory", "16g");
      },
      runProviderPreDeleteCleanup: () => events.push("cleanup"),
      upsertMessagingProviders: vi.fn((receivedTokenDefs) => {
        events.push("upsert");
        expect(receivedTokenDefs).toEqual(tokenDefs);
        return ["sandbox-telegram-bridge"];
      }),
      getHermesToolGatewayProviderName: (sandboxName) => {
        events.push("hermes");
        return `${sandboxName}-hermes-tools`;
      },
    });

    expect(events).toEqual(["policy", "resources", "cleanup", "upsert", "hermes"]);
    expect(result.createArgs).toEqual([
      "--from",
      "/tmp/nemoclaw-build-1/Dockerfile",
      "--name",
      "sandbox",
      "--policy",
      "/tmp/policy.yaml",
      "--gpu",
      "--memory",
      "16g",
      "--provider",
      "sandbox-telegram-bridge",
      "--provider",
      "sandbox-existing-discord",
      "--provider",
      "sandbox-hermes-tools",
      "--provider",
      "custom-provider",
    ]);
    expect(serializedIntent).not.toContain("telegram-super-secret");
    expect(JSON.stringify(intent)).toBe(serializedIntent);
  });

  it("rejects changed credential availability before running effects", () => {
    expectCredentialBindingFailure({
      plannedTokenDef: {
        name: "sandbox-telegram-bridge",
        envKey: "TELEGRAM_BOT_TOKEN",
        token: null,
      },
      materializedTokenDefs: [
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "new-secret",
        },
      ],
      expectedMessage:
        "Cannot materialize sandbox create intent; credential availability changed for provider 'sandbox-telegram-bridge'.",
    });
  });

  it("rejects a missing credential binding before running effects", () => {
    expectCredentialBindingFailure({
      plannedTokenDef: {
        name: "sandbox-telegram-bridge",
        envKey: "TELEGRAM_BOT_TOKEN",
        token: "telegram-secret",
      },
      materializedTokenDefs: [],
      expectedMessage:
        "Cannot materialize sandbox create intent; missing credential binding 'TELEGRAM_BOT_TOKEN' for provider 'sandbox-telegram-bridge'.",
    });
  });

  it("rejects a changed provider type before running effects", () => {
    expectCredentialBindingFailure({
      plannedTokenDef: {
        name: "sandbox-brave-search",
        envKey: "BRAVE_API_KEY",
        token: "brave-secret",
        providerType: "brave-search",
      },
      materializedTokenDefs: [
        {
          name: "sandbox-brave-search",
          envKey: "BRAVE_API_KEY",
          token: "brave-secret",
          providerType: "generic",
        },
      ],
      expectedMessage:
        "Cannot materialize sandbox create intent; provider type changed for 'sandbox-brave-search'.",
    });
  });
});

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
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "telegram-token",
        },
        {
          name: "sandbox-slack-app-bridge",
          envKey: "SLACK_APP_TOKEN",
          token: "slack-app-token",
        },
        {
          name: "sandbox-slack-bridge",
          envKey: "SLACK_BOT_TOKEN",
          token: "slack-bot-token",
        },
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
        policyTier: null,
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
      messagingTokenDefs: [
        {
          name: "sandbox-slack-app-bridge",
          envKey: "SLACK_APP_TOKEN",
          token: "slack-app-token",
        },
      ],
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

  it("appends extra providers via --provider after messaging and Hermes tool providers", () => {
    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels,
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingTokenDefs: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      extraProviders: ["tavily-search", "tavily-search", "custom-provider"],
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

    const providerArgs = result.createArgs
      .map((arg, index) => (arg === "--provider" ? result.createArgs[index + 1] : null))
      .filter((value): value is string => value !== null);
    expect(providerArgs).toEqual(["tavily-search", "custom-provider"]);
  });

  it("does not duplicate an extra provider that is already a messaging provider", () => {
    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["telegram"],
      disabledChannelNames: new Set(),
      messagingTokenDefs: [
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "telegram",
        },
      ],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      extraProviders: ["sandbox-telegram-bridge", "tavily-search"],
      hermesToolGateways: [],
      sandboxGpuConfig,
      dockerDriverGateway: true,
      appendResourceFlags: vi.fn(),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => ["sandbox-telegram-bridge"]),
      getMessagingChannelForEnvKey: (envKey) =>
        envKey === "TELEGRAM_BOT_TOKEN" ? "telegram" : null,
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

    const providerArgs = result.createArgs
      .map((arg, index) => (arg === "--provider" ? result.createArgs[index + 1] : null))
      .filter((value): value is string => value !== null);
    expect(providerArgs).toEqual(["sandbox-telegram-bridge", "tavily-search"]);
  });
});
