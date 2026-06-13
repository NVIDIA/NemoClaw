// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { discordManifest, slackManifest, telegramManifest } from "../../channels";
import type { ChannelManifest } from "../../manifest";
import { runMessagingHook } from "../hook-runner";
import { MessagingHookRegistry } from "../registry";
import {
  COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
  COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID,
  COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
  COMMON_HOOK_REGISTRATIONS,
  createTokenPasteHook,
} from "./index";

function findHookByHandler(manifest: ChannelManifest, handler: string) {
  return manifest.hooks.find((hook) => hook.handler === handler);
}

describe("common token-paste hook implementation", () => {
  it("uses the shared handler id declared by token-paste channel manifests", () => {
    expect(COMMON_HOOK_REGISTRATIONS.map((registration) => registration.id)).toEqual([
      COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID,
      COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
    ]);
    expect(findHookByHandler(telegramManifest, COMMON_TOKEN_PASTE_HOOK_HANDLER_ID)?.handler).toBe(
      COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
    );
    expect(findHookByHandler(discordManifest, COMMON_TOKEN_PASTE_HOOK_HANDLER_ID)?.handler).toBe(
      COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
    );
    expect(findHookByHandler(slackManifest, COMMON_TOKEN_PASTE_HOOK_HANDLER_ID)?.handler).toBe(
      COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
    );
  });

  it("requires an injected prompt when no env or credential value is available", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({ env: {}, log: () => {} }),
      },
    ]);
    const hook = telegramManifest.hooks[0];

    if (!hook) throw new Error("missing Telegram token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).rejects.toThrow("requires an injected prompt implementation");
  });

  it("shows the single-token enrollment output shape", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env: {},
          getCredential: () => "123456:test-telegram-token",
          saveCredential: () => {},
          log: () => {},
        }),
      },
    ]);
    const hook = telegramManifest.hooks[0];

    if (!hook) throw new Error("missing Telegram token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      phase: "enroll",
      outputs: {
        botToken: {
          kind: "secret",
          value: "123456:test-telegram-token",
        },
      },
    });
  });

  it("collects Slack bot and app tokens through the shared token-paste hook", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env: {},
          getCredential: (key) =>
            key === "SLACK_BOT_TOKEN"
              ? "xoxb-test-slack-token"
              : key === "SLACK_APP_TOKEN"
                ? "xapp-test-slack-token"
                : null,
          saveCredential: () => {},
          log: () => {},
        }),
      },
    ]);
    const hook = findHookByHandler(slackManifest, COMMON_TOKEN_PASTE_HOOK_HANDLER_ID);

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      phase: "enroll",
      outputs: {
        botToken: {
          kind: "secret",
          value: "xoxb-test-slack-token",
        },
        appToken: {
          kind: "secret",
          value: "xapp-test-slack-token",
        },
      },
    });
  });
});
