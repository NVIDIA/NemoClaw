// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { createBuiltInMessagingHookRegistry, MessagingHookRegistry } from "../hooks";
import {
  type ChannelManifest,
  ChannelManifestRegistry,
  type SandboxMessagingPlan,
} from "../manifest";
import { ManifestCompiler } from "./manifest-compiler";

const ALL_CHANNELS = ["telegram", "discord", "wechat", "slack", "whatsapp"] as const;
const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
  DISCORD_BOT_TOKEN: "test-discord-token",
  WECHAT_BOT_TOKEN: "test-wechat-token",
  SLACK_BOT_TOKEN: "xoxb-test-slack-token",
  SLACK_APP_TOKEN: "xapp-test-slack-token",
};
const TEST_WECHAT_LOGIN = {
  token: "test-wechat-token",
  accountId: "test-wechat-account",
  baseUrl: "https://ilinkai.wechat.com",
  userId: "test-wechat-user",
} as const;

function compiler(): ManifestCompiler {
  return new ManifestCompiler(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "",
        log: () => {},
      },
      slack: {
        validateCredentials: {
          log: () => {},
          validateCredentials: () => ({ ok: true }),
        },
      },
      telegram: {
        fetch: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
          async text() {
            return "";
          },
        }),
      },
      wechat: {
        ilinkLogin: {
          env: {},
          log: () => {},
          saveCredential: () => {},
          runLogin: async () => ({
            kind: "ok",
            credentials: TEST_WECHAT_LOGIN,
          }),
        },
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findFunctionPaths(value: unknown, prefix = "$"): string[] {
  if (typeof value === "function") return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findFunctionPaths(entry, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      findFunctionPaths(entry, `${prefix}.${key}`),
    );
  }
  return [];
}

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("ManifestCompiler", () => {
  it("compiles built-in manifests into a deterministic OpenClaw plan", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      configuredChannels: ["slack", "telegram", "wechat", "discord", "whatsapp"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        DISCORD_BOT_TOKEN: true,
        WECHAT_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.channels.map((channel) => channel.channelId)).toEqual(ALL_CHANNELS);
    expect(plan.channels.every((channel) => channel.active)).toBe(true);
    expect(plan.credentialBindings.map((binding) => binding.providerName)).toEqual([
      "demo-telegram-bridge",
      "demo-discord-bridge",
      "demo-wechat-bridge",
      "demo-slack-bridge",
      "demo-slack-app",
    ]);
    expect(plan.credentialBindings.map((binding) => binding.placeholder)).toEqual([
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
      "openshell:resolve:env:WECHAT_BOT_TOKEN",
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    ]);
    expect(plan.networkPolicy.entries).toEqual([
      {
        channelId: "telegram",
        presetName: "telegram",
        policyKeys: ["telegram_bot"],
        source: "manifest",
      },
      {
        channelId: "discord",
        presetName: "discord",
        policyKeys: ["discord"],
        source: "manifest",
      },
      {
        channelId: "wechat",
        presetName: "wechat",
        policyKeys: ["wechat_bridge"],
        source: "manifest",
      },
      {
        channelId: "slack",
        presetName: "slack",
        policyKeys: ["slack"],
        source: "manifest",
      },
      {
        channelId: "whatsapp",
        presetName: "whatsapp",
        policyKeys: ["whatsapp"],
        source: "manifest",
      },
    ]);
    expect(plan.agentRender.map((render) => `${render.channelId}:${render.renderId}`)).toEqual([
      "telegram:telegram-openclaw-channel",
      "telegram:telegram-openclaw-groups",
      "telegram:telegram-openclaw-plugin",
      "discord:discord-openclaw-channel",
      "discord:discord-openclaw-plugin",
      "wechat:wechat-openclaw-plugin",
      "slack:slack-openclaw-channel",
      "slack:slack-openclaw-plugin",
      "whatsapp:whatsapp-openclaw-channel",
      "whatsapp:whatsapp-openclaw-plugin",
    ]);
    expect(plan.agentRender.every((render) => render.handler === "common.staticOutputs")).toBe(
      true,
    );
    expect(JSON.stringify(plan.agentRender)).toContain("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
    expect(plan.buildSteps.map(({ value: _value, ...step }) => step)).toEqual([
      {
        channelId: "discord",
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
      },
      {
        channelId: "wechat",
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
      },
      {
        channelId: "wechat",
        kind: "build-file",
        hookId: "wechat-seed-openclaw-account",
        handler: "wechat.seedOpenClawAccount",
        outputId: "openclawWeixinAccountsIndex",
        required: true,
      },
      {
        channelId: "wechat",
        kind: "build-file",
        hookId: "wechat-seed-openclaw-account",
        handler: "wechat.seedOpenClawAccount",
        outputId: "openclawWeixinAccountFile",
        required: true,
      },
      {
        channelId: "wechat",
        kind: "build-file",
        hookId: "wechat-seed-openclaw-account",
        handler: "wechat.seedOpenClawAccount",
        outputId: "openclawConfigPatch",
        required: true,
      },
      {
        channelId: "slack",
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
      },
      {
        channelId: "whatsapp",
        kind: "package-install",
        outputId: "openclawPluginPackage",
        required: true,
      },
    ]);
    expect(plan.buildSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "package-install",
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/discord@{{openclaw.version}}",
            pin: true,
          },
        }),
        expect.objectContaining({
          channelId: "wechat",
          kind: "package-install",
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
            pin: true,
          },
        }),
      ]),
    );
    expect(plan.buildSteps.every((step) => step.value !== undefined)).toBe(true);
    expect(plan.stateUpdates).toContainEqual({
      channelId: "wechat",
      kind: "rebuild-hydration",
      statePath: "wechatConfig.accountId",
      env: "WECHAT_ACCOUNT_ID",
    });
    expect(plan.healthChecks).toEqual([
      {
        channelId: "telegram",
        phase: "health-check",
        requiredBefore: "lifecycle-success",
        hookIds: ["telegram-openclaw-bridge-health"],
      },
      {
        channelId: "discord",
        phase: "health-check",
        requiredBefore: "lifecycle-success",
        hookIds: ["discord-openclaw-bridge-health"],
      },
      {
        channelId: "wechat",
        phase: "health-check",
        requiredBefore: "lifecycle-success",
        hookIds: ["wechat-health-check"],
      },
      {
        channelId: "slack",
        phase: "health-check",
        requiredBefore: "lifecycle-success",
        hookIds: ["slack-openclaw-bridge-health"],
      },
    ]);
    expect(
      plan.agentRender.find(
        (render) => render.channelId === "telegram" && render.kind === "json-fragment",
      )?.templateRefs,
    ).toEqual([]);
  });

  it("compiles Hermes render and manifest-owned WeChat policy intent", async () => {
    const plan = await withEnv(
      {
        WECHAT_ACCOUNT_ID: "test-wechat-account",
      },
      () =>
        compiler().compile({
          sandboxName: "demo",
          agent: "hermes",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ALL_CHANNELS,
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
            DISCORD_BOT_TOKEN: true,
            WECHAT_BOT_TOKEN: true,
            SLACK_BOT_TOKEN: true,
            SLACK_APP_TOKEN: true,
          },
        }),
    );

    expect(plan.networkPolicy.entries.find((entry) => entry.channelId === "wechat")).toEqual({
      channelId: "wechat",
      presetName: "wechat",
      policyKeys: ["wechat_bridge"],
      source: "manifest",
    });
    expect(plan.agentRender.map((render) => `${render.channelId}:${render.target}`)).toEqual([
      "telegram:~/.hermes/.env",
      "telegram:~/.hermes/config.yaml",
      "discord:~/.hermes/.env",
      "discord:~/.hermes/config.yaml",
      "discord:~/.hermes/config.yaml",
      "wechat:~/.hermes/.env",
      "wechat:~/.hermes/config.yaml",
      "slack:~/.hermes/.env",
      "slack:~/.hermes/config.yaml",
      "whatsapp:~/.hermes/.env",
      "whatsapp:~/.hermes/config.yaml",
    ]);
    expect(JSON.stringify(plan.agentRender)).toContain(
      "WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN",
    );
    expect(plan.buildSteps).toEqual([]);
    expect(
      plan.channels
        .find((channel) => channel.channelId === "wechat")
        ?.inputs.find((input) => input.inputId === "accountId"),
    ).toMatchObject({
      kind: "config",
      value: "test-wechat-account",
    });
  });

  it("rejects line feeds in Slack Hermes env render values", async () => {
    for (const [envKey, value] of [
      ["SLACK_ALLOWED_USERS", "U123\nEVIL=1"],
      ["SLACK_ALLOWED_CHANNELS", "C123\nEVIL=1"],
    ] as const) {
      await expect(
        withEnv(
          {
            SLACK_BOT_TOKEN: "xoxb-test-slack-token",
            SLACK_APP_TOKEN: "xapp-test-slack-token",
            [envKey]: value,
          },
          () =>
            compiler().compile({
              sandboxName: "demo",
              agent: "hermes",
              workflow: "rebuild",
              isInteractive: false,
              configuredChannels: ["slack"],
              credentialAvailability: {
                SLACK_BOT_TOKEN: true,
                SLACK_APP_TOKEN: true,
              },
            }),
        ),
      ).rejects.toThrow(/line breaks/);
    }
  });

  it("rejects unsafe WeChat Hermes env render values", async () => {
    const cases: Array<readonly [string, string]> = [
      ["WECHAT_ACCOUNT_ID", "wechat-account\nEVIL=1"],
      ["WECHAT_BASE_URL", "https://ilinkai.wechat.com\nEVIL=1"],
      ["WECHAT_ALLOWED_IDS", "friend-one\nEVIL=1"],
    ];

    for (const [envKey, value] of cases) {
      await expect(
        withEnv(
          {
            WECHAT_ACCOUNT_ID: "wechat-account",
            WECHAT_BASE_URL: "https://ilinkai.wechat.com",
            WECHAT_ALLOWED_IDS: "friend-one",
            [envKey]: value,
          },
          () =>
            compiler().compile({
              sandboxName: "demo",
              agent: "hermes",
              workflow: "rebuild",
              isInteractive: false,
              configuredChannels: ["wechat"],
              credentialAvailability: {
                WECHAT_BOT_TOKEN: true,
              },
            }),
        ),
      ).rejects.toThrow(/line breaks/);
    }
  });

  it("rejects non-HTTPS or non-iLink WeChat baseUrl values", async () => {
    for (const baseUrl of ["http://ilinkai.wechat.com", "https://example.com"] as const) {
      await expect(
        withEnv(
          {
            WECHAT_ACCOUNT_ID: "wechat-account",
            WECHAT_BASE_URL: baseUrl,
          },
          () =>
            compiler().compile({
              sandboxName: "demo",
              agent: "hermes",
              workflow: "rebuild",
              isInteractive: false,
              configuredChannels: ["wechat"],
              credentialAvailability: {
                WECHAT_BOT_TOKEN: true,
              },
            }),
        ),
      ).rejects.toThrow(/WeChat baseUrl/);
    }
  });

  it("does not activate a requested channel while any required manifest input is missing", async () => {
    const plan = await withEnv(
      {
        WECHAT_ACCOUNT_ID: undefined,
      },
      () =>
        compiler().compile({
          sandboxName: "demo",
          agent: "hermes",
          workflow: "onboard",
          isInteractive: false,
          configuredChannels: ["wechat"],
          credentialAvailability: {
            WECHAT_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.channels[0]).toMatchObject({
      channelId: "wechat",
      active: false,
      disabled: true,
    });
    expect(plan.disabledChannels).toEqual(["wechat"]);
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["wechat"]);
    expect(plan.agentRender.map((render) => render.channelId)).toEqual(["wechat", "wechat"]);
    expect(plan.healthChecks.map((entry) => entry.channelId)).toEqual(["wechat"]);
  });

  it("runs enrollment hooks before returning the final channel input plan", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      configuredChannels: ["wechat", "telegram"],
    });

    const telegram = plan.channels.find((channel) => channel.channelId === "telegram");
    const wechat = plan.channels.find((channel) => channel.channelId === "wechat");

    expect(telegram?.inputs.find((input) => input.inputId === "botToken")).toMatchObject({
      kind: "secret",
      credentialAvailable: true,
    });
    expect(wechat?.inputs.find((input) => input.inputId === "botToken")).toMatchObject({
      kind: "secret",
      credentialAvailable: true,
    });
    expect(wechat?.inputs.find((input) => input.inputId === "accountId")).toMatchObject({
      kind: "config",
      value: "test-wechat-account",
    });
    expect(wechat?.inputs.find((input) => input.inputId === "baseUrl")).toMatchObject({
      kind: "config",
      value: "https://ilinkai.wechat.com",
    });
  });

  it("disables a channel when enrollment opts to skip it", async () => {
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: () => {
          throw new Error("operator cancelled token entry");
        },
      },
      {
        id: "telegram.getMeReachability",
        handler: () => {
          throw new Error("reachability should not run for skipped channels");
        },
      },
    ]);
    const plan = await new ManifestCompiler(
      createBuiltInChannelManifestRegistry(),
      hooks,
      createBuiltInRenderTemplateResolver(),
    ).compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      configuredChannels: ["telegram"],
    });

    expect(plan.channels[0]).toMatchObject({
      channelId: "telegram",
      active: false,
      selected: true,
      configured: false,
      disabled: true,
    });
    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.channels[0]?.hooks.map((hook) => hook.id)).toEqual([
      "telegram-token-paste",
      "telegram-allowlist-aliases",
      "telegram-config-prompt",
      "telegram-get-me-reachability",
      "telegram-openclaw-bridge-health",
      "telegram-gateway-conflict-status",
    ]);
    expect(plan.runtimeSetup).toEqual({ nodePreloads: [], envAliases: [], secretScans: [] });
    expect(plan.credentialBindings.map((binding) => binding.channelId)).toEqual(["telegram"]);
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["telegram"]);
    expect(plan.agentRender.map((render) => render.channelId)).toEqual(["telegram", "telegram"]);
    expect(plan.buildSteps).toEqual([]);
    expect(plan.stateUpdates.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "telegram",
      "telegram",
      "telegram",
    ]);
    expect(plan.healthChecks.map((entry) => entry.channelId)).toEqual(["telegram"]);
  });

  it("runs non-interactive enrollment hooks to validate and feed reachability checks", async () => {
    const hookCalls: string[] = [];
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: (context) => {
          hookCalls.push(`token-paste-input:${String(context.inputs?.botToken)}`);
          const token = process.env.TELEGRAM_BOT_TOKEN ?? "missing";
          return {
            outputs: {
              botToken: {
                kind: "secret",
                value: token,
              },
            },
          };
        },
      },
      {
        id: "common.configPrompt",
        handler: () => ({}),
      },
      {
        id: "telegram.allowlistAliases",
        handler: () => ({}),
      },
      {
        id: "telegram.getMeReachability",
        handler: (context) => {
          hookCalls.push(`reachability:${String(context.inputs?.botToken)}`);
          return {};
        },
      },
    ]);
    const plan = await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:raw-telegram-token",
      },
      () =>
        new ManifestCompiler(
          createBuiltInChannelManifestRegistry(),
          hooks,
          createBuiltInRenderTemplateResolver(),
        ).compile({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: false,
          configuredChannels: ["telegram"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.channels[0]?.inputs.find((input) => input.inputId === "botToken")).toMatchObject({
      kind: "secret",
      credentialAvailable: true,
    });
    expect(hookCalls).toEqual([
      "token-paste-input:undefined",
      "reachability:123456:raw-telegram-token",
    ]);
    expect(JSON.stringify(plan)).not.toContain("123456:raw-telegram-token");
  });

  it("disables a channel when a reachability check opts to skip it", async () => {
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: "123456:raw-telegram-token",
            },
          },
        }),
      },
      {
        id: "common.configPrompt",
        handler: () => ({}),
      },
      {
        id: "telegram.allowlistAliases",
        handler: () => ({}),
      },
      {
        id: "telegram.getMeReachability",
        handler: () => {
          throw new Error("telegram is unreachable");
        },
      },
    ]);
    const plan = await new ManifestCompiler(
      createBuiltInChannelManifestRegistry(),
      hooks,
      createBuiltInRenderTemplateResolver(),
    ).compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram"],
    });

    expect(plan.channels[0]).toMatchObject({
      channelId: "telegram",
      active: false,
      selected: true,
      configured: false,
      disabled: true,
    });
    expect(plan.disabledChannels).toEqual(["telegram"]);
  });

  it("reads input values from env keys before returning non-interactive plans", async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:raw-telegram-token",
        TELEGRAM_ALLOWED_IDS: "123456789",
      },
      async () => {
        const plan = await compiler().compile({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: false,
          configuredChannels: ["telegram"],
        });

        expect(
          plan.channels[0]?.inputs.find((input) => input.inputId === "botToken"),
        ).toMatchObject({
          kind: "secret",
          credentialAvailable: true,
        });
        expect(
          plan.channels[0]?.inputs.find((input) => input.inputId === "allowedIds"),
        ).toMatchObject({
          kind: "config",
          value: "123456789",
        });
        expect(JSON.stringify(plan)).not.toContain("123456:raw-telegram-token");
      },
    );
  });

  it("keeps compiled plans serializable, deterministic, and secret-free", async () => {
    const context = {
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
      },
    } as const;
    const first = await compiler().compile(context);
    const second = await compiler().compile(context);
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(jsonRoundTrip(first)).toEqual(first);
    expect(findFunctionPaths(first)).toEqual([]);
    expect(serialized).toContain("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
    expect(serialized).not.toContain("123456:raw-telegram-token");
    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "sandboxName",
      "agent",
      "workflow",
      "channels",
      "disabledChannels",
      "credentialBindings",
      "networkPolicy",
      "agentRender",
      "buildSteps",
      "runtimeSetup",
      "stateUpdates",
      "healthChecks",
    ] satisfies Array<keyof SandboxMessagingPlan>);
  });

  it("records disabled configured channels and leaves applier exclusion to disabledChannels", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "stop-channel",
      isInteractive: false,
      configuredChannels: ["telegram"],
      disabledChannels: ["telegram"],
    });

    expect(plan.channels).toHaveLength(1);
    expect(plan.channels[0]).toMatchObject({
      channelId: "telegram",
      active: false,
      configured: true,
      disabled: true,
    });
    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.credentialBindings.map((binding) => binding.channelId)).toEqual(["telegram"]);
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["telegram"]);
    expect(plan.agentRender.map((render) => render.channelId)).toEqual(["telegram", "telegram"]);
    expect(plan.buildSteps).toEqual([]);
    expect(plan.stateUpdates.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "telegram",
      "telegram",
      "telegram",
    ]);
    expect(plan.healthChecks.map((entry) => entry.channelId)).toEqual(["telegram"]);
    expect(plan.channels[0]?.hooks.map((hook) => hook.id)).toEqual([
      "telegram-token-paste",
      "telegram-allowlist-aliases",
      "telegram-config-prompt",
      "telegram-get-me-reachability",
      "telegram-openclaw-bridge-health",
      "telegram-gateway-conflict-status",
    ]);
    expect(plan.runtimeSetup).toEqual({ nodePreloads: [], envAliases: [], secretScans: [] });
  });

  it("compiles a non-built-in channel manifest through the same generic path", async () => {
    const hookCalls: string[] = [];
    const customManifest = {
      schemaVersion: 1,
      id: "matrix",
      displayName: "Matrix",
      supportedAgents: ["openclaw"],
      auth: {
        mode: "token-paste",
      },
      inputs: [
        {
          id: "accessToken",
          kind: "secret",
          required: true,
          envKey: "MATRIX_ACCESS_TOKEN",
        },
        {
          id: "roomId",
          kind: "config",
          required: true,
          envKey: "MATRIX_ROOM_ID",
        },
      ],
      credentials: [
        {
          id: "matrixAccessToken",
          sourceInput: "accessToken",
          providerName: "{sandboxName}-matrix-bridge",
          providerEnvKey: "MATRIX_ACCESS_TOKEN",
          placeholder: "openshell:resolve:env:MATRIX_ACCESS_TOKEN",
        },
      ],
      policyPresets: ["matrix"],
      render: [],
      state: {},
      hooks: [
        {
          id: "matrix-enroll",
          phase: "enroll",
          handler: "matrix.enroll",
          outputs: [
            {
              id: "accessToken",
              kind: "secret",
              required: true,
            },
            {
              id: "roomId",
              kind: "config",
              required: true,
            },
          ],
        },
        {
          id: "matrix-host-probe",
          phase: "reachability-check",
          handler: "matrix.probeHost",
          inputs: ["roomId"],
          onFailure: "abort",
        },
      ],
    } as const satisfies ChannelManifest;
    const hooks = new MessagingHookRegistry([
      {
        id: "matrix.enroll",
        handler: () => {
          hookCalls.push("enroll");
          return {
            outputs: {
              accessToken: {
                kind: "secret",
                value: "raw-matrix-token",
              },
              roomId: {
                kind: "config",
                value: "!room:example.com",
              },
            },
          };
        },
      },
      {
        id: "matrix.probeHost",
        handler: (context) => {
          hookCalls.push(`reachability:${String(context.inputs?.roomId)}`);
          return {};
        },
      },
    ]);
    const plan = await new ManifestCompiler(
      new ChannelManifestRegistry([customManifest]),
      hooks,
    ).compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      configuredChannels: ["matrix"],
    });

    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["matrix"]);
    expect(plan.channels[0]?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "accessToken",
        credentialAvailable: true,
      }),
    );
    expect(plan.channels[0]?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "roomId",
        value: "!room:example.com",
      }),
    );
    expect(plan.credentialBindings[0]).toMatchObject({
      channelId: "matrix",
      providerName: "demo-matrix-bridge",
      credentialAvailable: true,
    });
    expect(plan.networkPolicy.entries).toEqual([
      {
        channelId: "matrix",
        presetName: "matrix",
        policyKeys: ["matrix"],
        source: "manifest",
      },
    ]);
    expect(plan.channels[0]?.hooks).toContainEqual(
      expect.objectContaining({
        phase: "reachability-check",
        handler: "matrix.probeHost",
      }),
    );
    expect(hookCalls).toEqual(["enroll", "reachability:!room:example.com"]);
    expect(JSON.stringify(plan)).not.toContain("raw-matrix-token");
  });
});
