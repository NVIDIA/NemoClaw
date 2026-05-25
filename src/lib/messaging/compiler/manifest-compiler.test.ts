// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { FAKE_TELEGRAM_HOOK_REGISTRATIONS } from "../channels/telegram/hooks/fakes";
import { FAKE_WECHAT_HOOK_REGISTRATIONS } from "../channels/wechat/hooks/fakes";
import { MessagingHookRegistry } from "../hooks";
import { FAKE_COMMON_HOOK_REGISTRATIONS } from "../hooks/common";
import {
  ChannelManifestRegistry,
  type ChannelManifest,
  type SandboxMessagingPlan,
} from "../manifest";
import { ManifestCompiler } from "./manifest-compiler";

const ALL_CHANNELS = ["telegram", "discord", "wechat", "slack", "whatsapp"] as const;

function compiler(): ManifestCompiler {
  return new ManifestCompiler(
    createBuiltInChannelManifestRegistry(),
    new MessagingHookRegistry([
      ...FAKE_COMMON_HOOK_REGISTRATIONS,
      ...FAKE_TELEGRAM_HOOK_REGISTRATIONS,
      ...FAKE_WECHAT_HOOK_REGISTRATIONS,
    ]),
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
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
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
      selectedChannels: ["slack", "telegram", "wechat", "discord", "whatsapp"],
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
        source: "builtin",
      },
      {
        channelId: "discord",
        presetName: "discord",
        policyKeys: ["discord"],
        source: "builtin",
      },
      {
        channelId: "wechat",
        presetName: "wechat",
        policyKeys: ["wechat_bridge"],
        source: "builtin",
      },
      {
        channelId: "slack",
        presetName: "slack",
        policyKeys: ["slack"],
        source: "builtin",
      },
      {
        channelId: "whatsapp",
        presetName: "whatsapp",
        policyKeys: ["whatsapp"],
        source: "builtin",
      },
    ]);
    expect(plan.agentRender.map((render) => `${render.channelId}:${render.kind}`)).toEqual([
      "telegram:json-fragment",
      "telegram:json-fragment",
      "discord:json-fragment",
      "discord:json-fragment",
      "slack:json-fragment",
      "whatsapp:json-fragment",
    ]);
    expect(JSON.stringify(plan.agentRender)).toContain(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(plan.buildSteps).toEqual([
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
    ]);
    expect(plan.stateUpdates).toContainEqual({
      channelId: "wechat",
      kind: "rebuild-hydration",
      statePath: "wechatConfig.accountId",
      env: "WECHAT_ACCOUNT_ID",
    });
    expect(plan.healthChecks).toHaveLength(ALL_CHANNELS.length);
    expect(plan.healthChecks.every((check) => check.requiredBefore === "lifecycle-success")).toBe(
      true,
    );
    expect(
      plan.agentRender.find(
        (render) => render.channelId === "telegram" && render.kind === "json-fragment",
      )?.templateRefs,
    ).toEqual(expect.arrayContaining(["proxyUrl", "allowedIds.telegram.values"]));
  });

  it("compiles Hermes render and WeChat agent policy alias intent", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "hermes",
      workflow: "rebuild",
      isInteractive: false,
      selectedChannels: ALL_CHANNELS,
    });

    expect(plan.networkPolicy.entries.find((entry) => entry.channelId === "wechat")).toEqual({
      channelId: "wechat",
      presetName: "wechat",
      policyKeys: ["wechat_bridge"],
      source: "agent-alias",
    });
    expect(plan.agentRender.map((render) => `${render.channelId}:${render.target}`)).toEqual([
      "telegram:~/.hermes/.env",
      "telegram:~/.hermes/config.yaml",
      "discord:~/.hermes/.env",
      "discord:~/.hermes/config.yaml",
      "wechat:~/.hermes/.env",
      "slack:~/.hermes/.env",
      "whatsapp:~/.hermes/.env",
    ]);
    expect(JSON.stringify(plan.agentRender)).toContain(
      "WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN",
    );
    expect(plan.buildSteps).toEqual([]);
    expect(
      plan.channels
        .find((channel) => channel.channelId === "wechat")
        ?.inputs.find((input) => input.inputId === "accountId"),
    ).not.toHaveProperty("value");
  });

  it("runs enrollment hooks before returning the final channel input plan", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      selectedChannels: ["wechat", "telegram"],
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
      value: "fake-wechat-account",
    });
    expect(wechat?.inputs.find((input) => input.inputId === "baseUrl")).toMatchObject({
      kind: "config",
      value: "https://ilinkai.wechat.example",
    });
  });

  it("skips token-paste and QR enrollment hooks for non-interactive create plans", async () => {
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: () => {
          throw new Error("token-paste hook should not run");
        },
      },
    ]);
    const plan = await new ManifestCompiler(
      createBuiltInChannelManifestRegistry(),
      hooks,
    ).compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      selectedChannels: ["telegram"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
      },
    });

    expect(plan.channels[0]?.inputs.find((input) => input.inputId === "botToken")).toMatchObject({
      kind: "secret",
      credentialAvailable: true,
    });
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
          selectedChannels: ["telegram"],
        });

        expect(plan.channels[0]?.inputs.find((input) => input.inputId === "botToken")).toMatchObject({
          kind: "secret",
          credentialAvailable: true,
        });
        expect(plan.channels[0]?.inputs.find((input) => input.inputId === "allowedIds")).toMatchObject({
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
      selectedChannels: ["telegram"],
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
      "credentialBindings",
      "networkPolicy",
      "agentRender",
      "buildSteps",
      "stateUpdates",
      "healthChecks",
    ] satisfies Array<keyof SandboxMessagingPlan>);
  });

  it("records disabled configured channels without planning side effects for them", async () => {
    const plan = await compiler().compile({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "stop-channel",
      isInteractive: false,
      selectedChannels: [],
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
    expect(plan.credentialBindings).toEqual([]);
    expect(plan.networkPolicy.entries).toEqual([]);
    expect(plan.agentRender).toEqual([]);
    expect(plan.buildSteps).toEqual([]);
    expect(plan.stateUpdates).toEqual([]);
    expect(plan.healthChecks).toEqual([]);
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
      selectedChannels: ["matrix"],
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
    expect(hookCalls).toEqual([
      "enroll",
      "reachability:!room:example.com",
    ]);
    expect(JSON.stringify(plan)).not.toContain("raw-matrix-token");
  });
});
