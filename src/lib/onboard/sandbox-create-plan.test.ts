// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagingTokenDef } from "./messaging-prep";
import { materializeHermesPortableCreatePlan } from "./sandbox-create-plan-materialization";
import {
  materializeSandboxCreatePlan,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
  resolveSandboxCreatePolicyTier,
} from "./sandbox-create-plan";
import type { SandboxGpuCreateConfig } from "./sandbox-gpu-create";

const sandboxGpuConfig: SandboxGpuCreateConfig = {
  sandboxGpuEnabled: true,
  sandboxGpuDevice: null,
  hostGpuDetected: true,
};

const selectedSandboxGpuConfig: SandboxGpuCreateConfig = {
  ...sandboxGpuConfig,
  sandboxGpuDevice: "nvidia.com/gpu=0",
};

const disabledSandboxGpuConfig: SandboxGpuCreateConfig = {
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  hostGpuDetected: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    gpuRoutePlan: "native-only",
    sandboxGpuLogMessage: null,
    policyTier: null,
  });
  const preparePolicy = vi.fn(() => ({
    policyPath: "/tmp/policy.yaml",
    appliedPresets: [],
  }));
  const cleanupProviders = vi.fn();
  const upsertProviders = vi.fn(() => []);

  expect(() =>
    materializeSandboxCreatePlan({
      intent,
      fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
      messagingTokenDefs: materializedTokenDefs,
      prepareInitialSandboxCreatePolicy: preparePolicy,
      runProviderPreDeleteCleanup: cleanupProviders,
      upsertMessagingProviders: upsertProviders,
      getHermesToolGatewayProviderName: vi.fn(),
    }),
  ).toThrow(expectedMessage);
  expect(preparePolicy).not.toHaveBeenCalled();
  expect(cleanupProviders).not.toHaveBeenCalled();
  expect(upsertProviders).not.toHaveBeenCalled();
}

describe("resolveSandboxCreatePolicyTier", () => {
  it("recognizes Personal as a create-time policy tier", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "personal");

    expect(resolveSandboxCreatePolicyTier()).toBe("personal");
  });
});

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
      staleExtraProviders: ["stale-provider", "stale-provider", ""],
      hermesToolGateways: ["github"],
      sandboxGpuConfig: selectedSandboxGpuConfig,
      gpuCreateArgs: ["--gpu"],
      resourceCreateArgs: ["--cpu", "4", "--memory", "16Gi"],
      gpuRoutePlan: "native-only" as const,
      sandboxGpuLogMessage: "gpu note",
      extraPlaceholderKeys: ["TELEGRAM_BOT_TOKEN_AGENT_A"],
      agentName: "hermes",
      policyTier: "balanced",
      baselineExclusions: [
        {
          version: 1 as const,
          agent: "hermes",
          key: "nous_research",
          digest: "abc",
          acknowledgedAt: "2026-07-19T00:00:00.000Z",
          appliedAgentVersion: null,
        },
      ],
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
    expect(first.staleExtraProviders).toEqual(["stale-provider"]);
    expect(first.resourceCreateArgs).toEqual(["--cpu", "4", "--memory", "16Gi"]);
    expect(first.extraPlaceholderKeys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
    expect(first.sandboxGpuDevice).toBe("nvidia.com/gpu=0");
    expect(first.policy).toEqual({
      basePolicyPath: "/repo/policy.yaml",
      activeMessagingChannels: ["telegram", "discord", "whatsapp"],
      options: {
        directGpu: true,
        hostGpuAvailable: true,
        additionalPresets: ["github"],
        agentName: "hermes",
        policyTier: "balanced",
        baselineExclusions: [
          {
            version: 1,
            agent: "hermes",
            key: "nous_research",
            digest: "abc",
            acknowledgedAt: "2026-07-19T00:00:00.000Z",
            appliedAgentVersion: null,
          },
        ],
      },
    });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("/tmp/");
  });

  it("attaches a retained static provider while its channel runtime is stopped (#9773)", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/hermes-policy.yaml",
      sandboxName: "sandbox",
      channels,
      enabledChannels: ["discord"],
      disabledChannelNames: new Set(["discord"]),
      // Disabled credential definitions are not provider requests: onboard must
      // not create or update their gateway providers during the rebuild.
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: ["DISCORD_BOT_TOKEN"],
      reusableMessagingChannels: [],
      reusableMessagingProviders: ["sandbox-discord-bridge"],
      extraProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: disabledSandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: "balanced",
    });
    const upsertMessagingProviders = vi.fn(() => []);

    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: "/tmp/Dockerfile",
      messagingTokenDefs: [],
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders,
      getHermesToolGatewayProviderName: vi.fn(),
      prepareInitialSandboxCreatePolicy: vi.fn(() => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      })),
    });

    expect(upsertMessagingProviders).toHaveBeenCalledWith([], {
      replaceExisting: true,
      allowedSandboxes: ["sandbox"],
    });
    expect(plan.messagingProviders).toEqual(["sandbox-discord-bridge"]);
    expect(plan.createArgs).toContain("sandbox-discord-bridge");
  });

  it("keeps the real gateway provider while excluding direct host-local inference policy", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      inferenceProvider: "vllm-local",
      hostLocalInferenceRouteOnly: true,
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: ["local-inference"],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: "balanced",
    });
    const preparePolicy = vi.fn(() => ({
      policyPath: "/tmp/policy.yaml",
      appliedPresets: [],
    }));

    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
      messagingTokenDefs: [],
      prepareInitialSandboxCreatePolicy: preparePolicy,
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(() => "sandbox-hermes-tools"),
    });

    expect(intent.inferenceProvider).toBe("vllm-local");
    expect(intent.policy.options.hostLocalInferenceRouteOnly).toBe(true);
    expect(preparePolicy).toHaveBeenCalledWith(
      "/repo/policy.yaml",
      [],
      expect.objectContaining({ additionalPresets: [], sandboxName: "sandbox" }),
    );
    expect(plan.createArgs).toContain("vllm-local");
    expect(plan.createArgs).not.toContain("local-inference");
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
      sandboxGpuConfig: selectedSandboxGpuConfig,
      gpuCreateArgs: ["--gpu"],
      resourceCreateArgs: ["--memory", "16g"],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: "balanced",
    });
    const serializedIntent = JSON.stringify(intent);
    const events: string[] = [];

    const result = materializeSandboxCreatePlan({
      intent,
      fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
      messagingTokenDefs: tokenDefs,
      prepareInitialSandboxCreatePolicy: vi.fn(() => {
        events.push("policy");
        return { policyPath: "/tmp/policy.yaml", appliedPresets: ["telegram"] };
      }),
      discloseInitialSandboxPolicy: (policy) => {
        events.push("disclose");
        expect(policy.appliedPresets).toEqual(["telegram"]);
      },
      runProviderPreDeleteCleanup: () => events.push("cleanup"),
      upsertMessagingProviders: vi.fn((receivedTokenDefs, options) => {
        events.push("upsert");
        expect(receivedTokenDefs).toEqual(tokenDefs);
        expect(options).toEqual({
          replaceExisting: true,
          allowedSandboxes: ["sandbox"],
        });
        return ["sandbox-telegram-bridge"];
      }),
      getHermesToolGatewayProviderName: (sandboxName) => {
        events.push("hermes");
        return `${sandboxName}-hermes-tools`;
      },
    });

    expect(events).toEqual(["policy", "disclose", "cleanup", "upsert", "hermes"]);
    expect(result.createArgs).toEqual([
      "--from",
      "/tmp/nemoclaw-build-1/Dockerfile",
      "--name",
      "sandbox",
      "--policy",
      "/tmp/policy.yaml",
      "--driver-config-json",
      '{"docker":{"cdi_devices":["nvidia.com/gpu=0"]},"podman":{"cdi_devices":["nvidia.com/gpu=0"]}}',
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

  it("materializes a raw GPU UUID as Docker and Podman CDI driver config", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
      sandboxName: "portable-hermes",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: {
        ...sandboxGpuConfig,
        sandboxGpuDevice: "GPU-69adb14e-820e-bfb4-0993-171e73f68504",
      },
      gpuCreateArgs: ["--gpu"],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: null,
    });

    const plan = materializeHermesPortableCreatePlan({
      intent,
      fromRef: "ghcr.io/nvidia/nemoclaw/hermes:test",
    });
    const configIndex = plan.createArgs.indexOf("--driver-config-json");

    expect(JSON.parse(plan.createArgs[configIndex + 1]!)).toEqual({
      docker: {
        cdi_devices: ["nvidia.com/gpu=GPU-69adb14e-820e-bfb4-0993-171e73f68504"],
      },
      podman: {
        cdi_devices: ["nvidia.com/gpu=GPU-69adb14e-820e-bfb4-0993-171e73f68504"],
      },
    });
    expect(plan.createArgs).toContain("--gpu");
    expect(plan.createArgs).not.toContain("--gpu-device");
  });

  it("rejects GPU device driver config without the typed GPU request", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: { sandboxGpuEnabled: false, sandboxGpuDevice: "0" },
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      policyTier: null,
    });

    expect(() =>
      materializeSandboxCreatePlan({
        intent,
        fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
        messagingTokenDefs: [],
        prepareInitialSandboxCreatePolicy: vi.fn(),
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(),
      }),
    ).toThrow("Sandbox GPU device selection requires the OpenShell GPU request.");
  });

  it("materializes a read-only Docker bind beside the DCode tmpfs mount", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      hostMounts: [{ source: "/srv/project", target: "/sandbox/project", readOnly: true }],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "langchain-deepagents-code",
      policyTier: null,
    });
    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
      messagingTokenDefs: [],
      prepareInitialSandboxCreatePolicy: vi.fn(() => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      })),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(),
    });
    const configIndex = plan.createArgs.indexOf("--driver-config-json");
    const driverConfig = JSON.parse(plan.createArgs[configIndex + 1]!);

    expect(configIndex).toBeGreaterThan(-1);
    expect(driverConfig.docker.mounts).toEqual([
      {
        type: "tmpfs",
        target: "/run/nemoclaw-dcode-mcp",
        options: ["noexec"],
        size_bytes: 1_048_576,
        mode: 0o1777,
      },
      {
        type: "bind",
        source: "/srv/project",
        target: "/sandbox/project",
        read_only: true,
      },
    ]);
    expect(driverConfig.podman.mounts).toEqual([driverConfig.docker.mounts[0]]);
  });

  it("passes the managed Hermes state volume through the Docker driver config", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "hermes-box",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: null,
    });
    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`,
      managedStateMount: {
        type: "volume",
        source: "nemoclaw-hermes-state-v1-hermes-box",
        target: "/sandbox/.hermes",
        read_only: false,
      },
      messagingTokenDefs: [],
      prepareInitialSandboxCreatePolicy: vi.fn(() => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      })),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(),
    });
    const configIndex = plan.createArgs.indexOf("--driver-config-json");

    expect(JSON.parse(plan.createArgs[configIndex + 1]!)).toEqual({
      docker: {
        mounts: [
          {
            type: "volume",
            source: "nemoclaw-hermes-state-v1-hermes-box",
            target: "/sandbox/.hermes",
            read_only: false,
          },
        ],
      },
    });
  });

  it("rejects host mounts that overlap the managed Hermes state root", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "hermes-box",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      hostMounts: [{ source: "/srv/hermes", target: "/sandbox/.hermes", readOnly: true }],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
      policyTier: null,
    });

    expect(() =>
      materializeSandboxCreatePlan({
        intent,
        fromRef: `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`,
        managedStateMount: {
          type: "volume",
          source: "nemoclaw-hermes-state-v1-hermes-box",
          target: "/sandbox/.hermes",
          read_only: false,
        },
        messagingTokenDefs: [],
        prepareInitialSandboxCreatePolicy: vi.fn(() => ({
          policyPath: "/tmp/policy.yaml",
          appliedPresets: [],
        })),
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(),
      }),
    ).toThrow(/conflicts with the managed Hermes state root/u);
  });

  it("cleans up the prepared policy when disclosure fails before provider effects (#7179)", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels,
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      policyTier: null,
    });
    const cleanupPolicy = vi.fn(() => true);
    const cleanupProviders = vi.fn();
    const upsertProviders = vi.fn(() => []);

    expect(() =>
      materializeSandboxCreatePlan({
        intent,
        fromRef: "/tmp/nemoclaw-build-1/Dockerfile",
        messagingTokenDefs: [],
        prepareInitialSandboxCreatePolicy: vi.fn(() => ({
          policyPath: "/tmp/policy.yaml",
          appliedPresets: [],
          cleanup: cleanupPolicy,
        })),
        discloseInitialSandboxPolicy: () => {
          throw new Error("disclosure failed");
        },
        runProviderPreDeleteCleanup: cleanupProviders,
        upsertMessagingProviders: upsertProviders,
        getHermesToolGatewayProviderName: vi.fn(),
      }),
    ).toThrow("disclosure failed");
    expect(cleanupPolicy).toHaveBeenCalledOnce();
    expect(cleanupProviders).not.toHaveBeenCalled();
    expect(upsertProviders).not.toHaveBeenCalled();
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

  it("materializes a managed image reference without a Dockerfile suffix", () => {
    const reference = `ghcr.io/nvidia/nemoclaw/openclaw@sha256:${"a".repeat(64)}`;
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
      policyTier: null,
    });

    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: reference,
      messagingTokenDefs: [],
      prepareInitialSandboxCreatePolicy: vi.fn(() => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      })),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(),
    });
    const fromIndex = plan.createArgs.indexOf("--from");

    expect(plan.createArgs.slice(fromIndex, fromIndex + 2)).toEqual(["--from", reference]);
    expect(plan.createArgs.join(" ")).not.toContain("/Dockerfile");
  });
});
