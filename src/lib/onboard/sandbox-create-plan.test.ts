// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
import type { MessagingTokenDef } from "./messaging-prep";
import {
  materializeHermesPortableCreatePlan,
  prepareSandboxCreatePolicy,
} from "./sandbox-create-plan-materialization";
import {
  materializeSandboxCreatePlan,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
  resolveSandboxCreatePolicyTier,
} from "./sandbox-create-plan";
import type { prepareInitialSandboxCreatePolicy } from "./initial-policy";
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
    name: "discord",
    envKey: "DISCORD_BOT_TOKEN",
    label: "Discord",
    description: "Discord",
    help: "Discord",
  },
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

const discordProviderName = "sandbox-discord-bridge";

function resolveDiscordCreateIntent(input: {
  selected: boolean;
  reusable?: boolean;
  policyTier?: "balanced" | "restricted";
}) {
  const messagingTokenDefs: MessagingTokenDef[] = [
    {
      name: discordProviderName,
      envKey: "DISCORD_BOT_TOKEN",
      token: "discord-secret",
      providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    },
  ];
  const intent = resolveSandboxCreateIntent({
    basePolicyPath: "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    sandboxName: "sandbox",
    channels,
    enabledChannels: input.selected ? ["discord"] : [],
    disabledChannelNames: new Set(),
    messagingProviderRequests: resolveSandboxCreateMessagingProviderRequests(
      messagingTokenDefs,
      () => "discord",
    ),
    primaryMessagingCredentialEnvKeys: ["DISCORD_BOT_TOKEN"],
    reusableMessagingChannels: input.reusable ? ["discord"] : [],
    reusableMessagingProviders: input.reusable ? [discordProviderName] : [],
    hermesToolGateways: [],
    sandboxGpuConfig: disabledSandboxGpuConfig,
    gpuCreateArgs: [],
    gpuRoutePlan: "none",
    sandboxGpuLogMessage: null,
    agentName: "openclaw",
    policyTier: input.policyTier ?? null,
  });
  return { intent, messagingTokenDefs };
}

type DiscordPlanOverrides = Partial<
  Pick<
    Parameters<typeof materializeSandboxCreatePlan>[0],
    | "prepareInitialSandboxCreatePolicy"
    | "runProviderPreDeleteCleanup"
    | "upsertMessagingProviders"
    | "getHermesToolGatewayProviderName"
  >
>;

function materializeDiscordCreatePlan(
  resolved: ReturnType<typeof resolveDiscordCreateIntent>,
  overrides: DiscordPlanOverrides = {},
) {
  return materializeSandboxCreatePlan({
    ...resolved,
    fromRef: "/tmp/Dockerfile",
    runProviderPreDeleteCleanup: vi.fn(),
    upsertMessagingProviders: vi.fn(() => [discordProviderName]),
    getHermesToolGatewayProviderName: vi.fn(),
    ...overrides,
  });
}

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

describe("prepareSandboxCreatePolicy", () => {
  it("passes the sandbox name so credential-binding presets can materialize", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "bound-sandbox",
      channels,
      enabledChannels: ["telegram"],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: disabledSandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "native-only",
      sandboxGpuLogMessage: null,
    });
    const seenOptions: Array<Record<string, unknown>> = [];
    const preparePolicy: typeof prepareInitialSandboxCreatePolicy = (
      _basePolicyPath,
      _channels,
      options,
    ) => {
      seenOptions.push(options as unknown as Record<string, unknown>);
      return { policyPath: "/tmp/policy.yaml", appliedPresets: [] };
    };

    const messagingConfig = { WECHAT_BASE_URL: "https://idc-37.weixin.qq.com" };
    prepareSandboxCreatePolicy(intent, preparePolicy, messagingConfig);

    expect(seenOptions[0]).toMatchObject({ sandboxName: "bound-sandbox", messagingConfig });
  });

  it("materializes the captured exact WeChat IDC endpoint in the create policy (#10606)", () => {
    const resolved = resolveDiscordCreateIntent({ selected: false });
    const sandboxName = "openclaw-wechat-idc";
    const providerName = `${sandboxName}-wechat-bridge`;
    const messagingTokenDefs: MessagingTokenDef[] = [
      {
        name: providerName,
        envKey: "WECHAT_BOT_TOKEN",
        token: "test-wechat-token",
        providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      },
    ];
    const intent = {
      ...resolved.intent,
      sandboxName,
      activeMessagingChannels: ["wechat"],
      messagingProviderRequests: [
        {
          name: providerName,
          envKey: "WECHAT_BOT_TOKEN",
          providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          credentialConfigured: true,
          channel: "wechat",
        },
      ],
      policy: {
        ...resolved.intent.policy,
        basePolicyPath: path.join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "nemoclaw-blueprint",
          "policies",
          "openclaw-sandbox.yaml",
        ),
        activeMessagingChannels: ["wechat"],
        options: { ...resolved.intent.policy.options, agentName: "openclaw" },
      },
    };
    const plan = materializeSandboxCreatePlan({
      ...resolved,
      intent,
      fromRef: "/tmp/Dockerfile",
      messagingTokenDefs,
      messagingConfig: { WECHAT_BASE_URL: "https://idc-37.weixin.qq.com" },
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => [providerName]),
      getHermesToolGatewayProviderName: vi.fn(),
    });

    try {
      const effective = YAML.parse(
        fs.readFileSync(plan.initialSandboxPolicy.policyPath, "utf8"),
      ) as {
        network_policies: {
          wechat_bridge: {
            endpoints: Array<{
              host: string;
              port: number;
              protocol: string;
              enforcement: string;
              credential_binding?: { provider?: string };
              rules?: Array<{ allow?: { method?: string; path?: string } }>;
            }>;
          };
        };
      };
      const endpoints = effective.network_policies.wechat_bridge.endpoints;

      expect(endpoints.find(({ host }) => host === "idc-37.weixin.qq.com")).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        credential_binding: { provider: `${sandboxName}-wechat-bridge` },
        rules: [
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "POST", path: "/**" } },
        ],
      });
      expect(endpoints.filter(({ host }) => host.startsWith("idc-"))).toHaveLength(1);
      expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");
    } finally {
      plan.initialSandboxPolicy.cleanup?.();
    }
  });
});

describe("resolveSandboxCreatePolicyTier", () => {
  it("recognizes Personal as a create-time policy tier", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "personal");

    expect(resolveSandboxCreatePolicyTier()).toBe("personal");
  });

  it("ends policy-tier transport after initial policy composition", () => {
    const resolved = resolveDiscordCreateIntent({ selected: false, policyTier: "balanced" });
    const preparePolicy = vi.fn(() => ({
      policyPath: "/tmp/policy.yaml",
      appliedPresets: ["openclaw-diagnostics-otel-local"],
    }));

    const plan = materializeDiscordCreatePlan(resolved, {
      prepareInitialSandboxCreatePolicy: preparePolicy,
    });

    expect(preparePolicy).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ policyTier: "balanced" }),
    );
    expect(plan.initialSandboxPolicy.appliedPresets).toContain(
      "openclaw-diagnostics-otel-local",
    );
    expect(plan).not.toHaveProperty("policyTier");
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
    };

    const first = resolveSandboxCreateIntent(input);
    const second = resolveSandboxCreateIntent(input);

    expect(first).toEqual(second);
    expect(first.activeMessagingChannels).toEqual(["telegram", "whatsapp"]);
    expect(first.messagingProviderRequests.map(({ name }) => name)).toEqual([
      "sandbox-telegram-bridge",
      "sandbox-slack-bridge",
    ]);
    expect(first.reusableMessagingProviders).toEqual([
      "sandbox-existing-discord",
      "sandbox-slack-bridge",
    ]);
    expect(first.extraProviders).toEqual(["custom-provider"]);
    expect(first.staleExtraProviders).toEqual(["stale-provider"]);
    expect(first.resourceCreateArgs).toEqual(["--cpu", "4", "--memory", "16Gi"]);
    expect(first.extraPlaceholderKeys).toEqual(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
    expect(first.sandboxGpuDevice).toBe("nvidia.com/gpu=0");
    expect(first.policy).toEqual({
      basePolicyPath: "/repo/policy.yaml",
      activeMessagingChannels: ["telegram", "whatsapp"],
      options: {
        directGpu: true,
        hostGpuAvailable: true,
        additionalPresets: ["github"],
        agentName: "hermes",
        policyTier: null,
      },
    });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("/tmp/");
  });

  it(
    "omits Discord create-time effects when an unselected credential is available",
    testTimeoutOptions(15_000),
    () => {
      const { intent, messagingTokenDefs } = resolveDiscordCreateIntent({
        selected: false,
        reusable: true,
      });
      const upsertMessagingProviders = vi.fn((tokenDefs: MessagingTokenDef[]) =>
        tokenDefs.map(({ name }) => name),
      );

      const plan = materializeDiscordCreatePlan(
        { intent, messagingTokenDefs },
        { upsertMessagingProviders },
      );

      expect(intent.reusableMessagingProviders).toEqual([]);
      expect(plan.activeMessagingChannels).toEqual([]);
      expect(plan.initialSandboxPolicy.appliedPresets).not.toContain("discord");
      expect(plan.initialSandboxPolicy.credentialBindingProviders ?? []).not.toContain(
        discordProviderName,
      );
      expect(plan.messagingProviders).not.toContain(discordProviderName);
      expect(plan.createArgs).not.toContain(discordProviderName);
      expect(upsertMessagingProviders).toHaveBeenCalledWith([], {
        replaceExisting: true,
        allowedSandboxes: ["sandbox"],
      });
      plan.initialSandboxPolicy.cleanup?.();
    },
  );

  it("attaches the selected Discord provider to its create-time policy", () => {
    const { intent, messagingTokenDefs } = resolveDiscordCreateIntent({
      selected: true,
    });

    const plan = materializeDiscordCreatePlan({ intent, messagingTokenDefs });

    expect(plan.activeMessagingChannels).toEqual(["discord"]);
    expect(plan.initialSandboxPolicy.appliedPresets).toContain("discord");
    expect(plan.initialSandboxPolicy.credentialBindingProviders).toEqual([discordProviderName]);
    expect(plan.messagingProviders).toEqual([discordProviderName]);
    expect(plan.createArgs).toContain(discordProviderName);
    plan.initialSandboxPolicy.cleanup?.();
  });

  it("rejects selected Discord when its provider cannot be prepared", () => {
    const { intent, messagingTokenDefs } = resolveDiscordCreateIntent({
      selected: true,
    });

    expect(() =>
      materializeDiscordCreatePlan(
        { intent, messagingTokenDefs },
        { upsertMessagingProviders: vi.fn(() => []) },
      ),
    ).toThrow(
      `Cannot create sandbox; create-time policy requires credential provider '${discordProviderName}', but the sandbox create plan does not attach it.`,
    );
  });

  it("rejects every create-time policy credential binding missing from the provider set", () => {
    const { intent, messagingTokenDefs } = resolveDiscordCreateIntent({
      selected: true,
    });
    const cleanupPolicy = vi.fn(() => true);
    const cleanupProviders = vi.fn();
    const upsertMessagingProviders = vi.fn(() => [discordProviderName]);

    expect(() =>
      materializeDiscordCreatePlan(
        { intent, messagingTokenDefs },
        {
          prepareInitialSandboxCreatePolicy: vi.fn(() => ({
            policyPath: "/tmp/policy.yaml",
            appliedPresets: ["discord"],
            credentialBindingProviders: [discordProviderName, "sandbox-missing-provider"],
            cleanup: cleanupPolicy,
          })),
          runProviderPreDeleteCleanup: cleanupProviders,
          upsertMessagingProviders,
        },
      ),
    ).toThrow(
      "Cannot create sandbox; create-time policy requires credential provider 'sandbox-missing-provider', but the sandbox create plan does not attach it.",
    );
    expect(cleanupPolicy).toHaveBeenCalledOnce();
    expect(cleanupProviders).not.toHaveBeenCalled();
    expect(upsertMessagingProviders).not.toHaveBeenCalled();
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
    expect(intent.reusableMessagingProviders).toEqual(["sandbox-discord-bridge"]);
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

    expect(events).toEqual(["policy", "hermes", "disclose", "cleanup", "upsert"]);
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

  it("rejects deferred provider plans before provider effects or sandbox creation (#9833)", () => {
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
      inferenceProvider: "nvidia-prod",
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
      sandboxGpuConfig: disabledSandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
    });
    const events: string[] = [];
    const cleanupPolicy = vi.fn(() => {
      events.push("policy-cleanup");
      return true;
    });
    const runProviderPreDeleteCleanup = vi.fn(() => events.push("provider-cleanup"));
    const upsertMessagingProviders = vi.fn(() => {
      events.push("upsert");
      return ["sandbox-telegram-bridge"];
    });
    const getHermesToolGatewayProviderName = vi.fn(() => {
      events.push("hermes");
      return "sandbox-hermes-tools";
    });

    expect(() =>
      materializeSandboxCreatePlan({
        intent,
        fromRef: "example.invalid/image@sha256:abc",
        deferSandboxEffectsUntilIdentityVerification: true,
        messagingTokenDefs: tokenDefs,
        prepareInitialSandboxCreatePolicy: () => ({
          policyPath: "/tmp/policy.yaml",
          appliedPresets: ["telegram"],
          cleanup: cleanupPolicy,
        }),
        runProviderPreDeleteCleanup,
        upsertMessagingProviders,
        getHermesToolGatewayProviderName,
      }),
    ).toThrow("No sandbox was created");

    expect(events).toEqual(["policy-cleanup"]);
    expect(cleanupPolicy).toHaveBeenCalledOnce();
    expect(runProviderPreDeleteCleanup).not.toHaveBeenCalled();
    expect(upsertMessagingProviders).not.toHaveBeenCalled();
    expect(getHermesToolGatewayProviderName).not.toHaveBeenCalled();
  });

  it("keeps the NemoClaw policy on a managed create when effects are deferred (#9833)", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      inferenceProvider: null,
      channels,
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      extraProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: disabledSandboxGpuConfig,
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      agentName: "openclaw",
    });
    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: "example.invalid/image@sha256:abc",
      deferSandboxEffectsUntilIdentityVerification: true,
      messagingTokenDefs: [],
      prepareInitialSandboxCreatePolicy: () => ({
        policyPath: "/tmp/policy.yaml",
        appliedPresets: [],
      }),
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(),
    });

    expect(plan.createArgs).toEqual(expect.arrayContaining(["--policy", "/tmp/policy.yaml"]));
    expect(plan.createArgs).not.toContain("--provider");
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
        token: "telegram-secret",
      },
      materializedTokenDefs: [
        {
          name: "sandbox-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: null,
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
