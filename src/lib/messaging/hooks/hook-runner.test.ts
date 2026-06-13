// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelHookSpec } from "../manifest";
import {
  createBuiltInMessagingHookRegistry,
  MessagingHookRegistry,
  runMessagingHook,
} from "./index";

const HOST_QR_HOOK = {
  id: "wechat-host-qr",
  phase: "enroll",
  handler: "wechat.ilinkLogin",
  outputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
    },
    {
      id: "accountId",
      kind: "config",
      required: true,
    },
  ],
} as const satisfies ChannelHookSpec;

describe("MessagingHookRegistry", () => {
  it("constructs the production built-in hook registry", () => {
    const registry = createBuiltInMessagingHookRegistry();

    expect(registry.listIds()).toEqual([
      "common.staticOutputs",
      "common.tokenPaste",
      "common.configPrompt",
      "slack.validateCredentials",
      "telegram.allowlistAliases",
      "telegram.getMeReachability",
      "wechat.ilinkLogin",
      "wechat.seedOpenClawAccount",
      "wechat.healthCheck",
    ]);
  });

  it("returns declared static outputs for manifest-owned build and render hooks", async () => {
    const registry = createBuiltInMessagingHookRegistry();
    const hook = {
      id: "discord-openclaw-package-install",
      phase: "agent-install",
      handler: "common.staticOutputs",
      outputs: [
        {
          id: "openclawPluginPackage",
          kind: "package-install",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/discord@{{openclaw.version}}",
            pin: true,
          },
        },
      ],
    } as const satisfies ChannelHookSpec;

    await expect(runMessagingHook(hook, registry, { channelId: "discord" })).resolves.toEqual({
      hookId: "discord-openclaw-package-install",
      handlerId: "common.staticOutputs",
      phase: "agent-install",
      outputs: {
        openclawPluginPackage: {
          kind: "package-install",
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/discord@{{openclaw.version}}",
            pin: true,
          },
        },
      },
    });
  });

  it("registers handlers by stable handler id", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: "wechat.ilinkLogin",
        handler: (context) => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: `token-for-${context.channelId}`,
            },
            accountId: {
              kind: "config",
              value: "wxid_demo",
            },
          },
        }),
      },
    ]);

    const result = await runMessagingHook(HOST_QR_HOOK, registry, {
      channelId: "wechat",
    });

    expect(result).toEqual({
      hookId: "wechat-host-qr",
      handlerId: "wechat.ilinkLogin",
      phase: "enroll",
      outputs: {
        botToken: {
          kind: "secret",
          value: "token-for-wechat",
        },
        accountId: {
          kind: "config",
          value: "wxid_demo",
        },
      },
    });
  });

  it("passes hook metadata, phase, and serializable inputs to registered handlers", async () => {
    const calls: unknown[] = [];
    const hook = {
      id: "wechat-seed-openclaw-account",
      phase: "post-agent-install",
      handler: "wechat.seedOpenClawAccount",
      inputs: ["wechatConfig.accountId"],
      outputs: [
        {
          id: "accountFile",
          kind: "build-file",
          required: true,
        },
      ],
      onFailure: "abort",
    } as const satisfies ChannelHookSpec;
    const registry = new MessagingHookRegistry([
      {
        id: "wechat.seedOpenClawAccount",
        handler: (context) => {
          calls.push(context);
          return {
            outputs: {
              accountFile: {
                kind: "build-file",
                value: {
                  path: "accounts/default.json",
                  mode: "seed",
                },
              },
            },
          };
        },
      },
    ]);

    const result = await runMessagingHook(hook, registry, {
      channelId: "wechat",
      inputs: {
        "wechatConfig.accountId": "ilink-bot-42",
      },
    });

    expect(calls).toEqual([
      {
        channelId: "wechat",
        hookId: "wechat-seed-openclaw-account",
        phase: "post-agent-install",
        inputs: {
          "wechatConfig.accountId": "ilink-bot-42",
        },
        outputDeclarations: [
          {
            id: "accountFile",
            kind: "build-file",
            required: true,
          },
        ],
      },
    ]);
    expect(result.outputs.accountFile).toEqual({
      kind: "build-file",
      value: {
        path: "accounts/default.json",
        mode: "seed",
      },
    });
  });

  it("rejects duplicate handler ids", () => {
    const handler = () => ({});

    expect(
      () =>
        new MessagingHookRegistry([
          { id: "wechat.ilinkLogin", handler },
          { id: "wechat.ilinkLogin", handler },
        ]),
    ).toThrow("Duplicate messaging hook handler id 'wechat.ilinkLogin'");
  });

  it("reports missing handlers deterministically", async () => {
    await expect(
      runMessagingHook(HOST_QR_HOOK, new MessagingHookRegistry(), {
        channelId: "wechat",
      }),
    ).rejects.toThrow("Missing messaging hook handler 'wechat.ilinkLogin'");
  });

  it("checks required declared outputs", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: "wechat.ilinkLogin",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: "token",
            },
          },
        }),
      },
    ]);

    await expect(
      runMessagingHook(HOST_QR_HOOK, registry, {
        channelId: "wechat",
      }),
    ).rejects.toThrow("Hook 'wechat-host-qr' missing required output 'accountId'");
  });

  it("allows shared non-cyclic object references in serializable outputs", async () => {
    const shared = {
      path: "accounts/default.json",
      mode: "seed",
    };
    const registry = new MessagingHookRegistry([
      {
        id: "wechat.sharedOutput",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: [shared, shared],
            },
            accountId: {
              kind: "config",
              value: "wxid_demo",
            },
          },
        }),
      },
    ]);

    await expect(
      runMessagingHook(
        {
          ...HOST_QR_HOOK,
          handler: "wechat.sharedOutput",
        },
        registry,
        {
          channelId: "wechat",
        },
      ),
    ).resolves.toMatchObject({
      outputs: {
        botToken: {
          kind: "secret",
          value: [shared, shared],
        },
      },
    });
  });

  it("checks output ids, kinds, and serializable values", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const registry = new MessagingHookRegistry([
      {
        id: "wechat.kindMismatch",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "config",
              value: "token",
            },
            accountId: {
              kind: "config",
              value: "wxid_demo",
            },
          },
        }),
      },
      {
        id: "wechat.extraOutput",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: "token",
            },
            accountId: {
              kind: "config",
              value: "wxid_demo",
            },
            buildPath: {
              kind: "build-file",
              value: "accounts.json",
            },
          },
        }),
      },
      {
        id: "wechat.badValue",
        handler: () => ({
          outputs: {
            botToken: {
              kind: "secret",
              value: circular as never,
            },
            accountId: {
              kind: "config",
              value: "wxid_demo",
            },
          },
        }),
      },
    ]);

    await expect(
      runMessagingHook(
        {
          ...HOST_QR_HOOK,
          handler: "wechat.kindMismatch",
        },
        registry,
        {
          channelId: "wechat",
        },
      ),
    ).rejects.toThrow(
      "Hook 'wechat-host-qr' output 'botToken' kind 'config' does not match declared kind 'secret'",
    );
    await expect(
      runMessagingHook(
        {
          ...HOST_QR_HOOK,
          handler: "wechat.extraOutput",
        },
        registry,
        {
          channelId: "wechat",
        },
      ),
    ).rejects.toThrow("Hook 'wechat-host-qr' returned undeclared output 'buildPath'");
    await expect(
      runMessagingHook(
        {
          ...HOST_QR_HOOK,
          handler: "wechat.badValue",
        },
        registry,
        {
          channelId: "wechat",
        },
      ),
    ).rejects.toThrow("Hook 'wechat-host-qr' output 'botToken' is not serializable");
  });
});
