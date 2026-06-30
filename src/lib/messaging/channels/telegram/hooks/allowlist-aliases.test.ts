// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import type { ChannelHookSpec } from "../../../manifest";
import {
  createTelegramAllowlistAliasesHook,
  TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
} from "./allowlist-aliases";

const TELEGRAM_ALLOWLIST_ALIASES_HOOK = {
  id: "telegram-allowlist-aliases",
  phase: "enroll",
  handler: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
  outputs: [
    {
      id: "allowedIds",
      kind: "config",
    },
  ],
} as const satisfies ChannelHookSpec;

describe("Telegram allowlist aliases hook implementation", () => {
  it("merges compatibility aliases into canonical TELEGRAM_ALLOWED_IDS", async () => {
    const env: NodeJS.ProcessEnv = {
      TELEGRAM_ALLOWED_IDS: "111, 222",
      TELEGRAM_AUTHORIZED_CHAT_IDS: "333,222",
      TELEGRAM_CHAT_ID: "444",
    };
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
        handler: createTelegramAllowlistAliasesHook({ env }),
      },
    ]);

    await expect(
      runMessagingHook(TELEGRAM_ALLOWLIST_ALIASES_HOOK, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      hookId: "telegram-allowlist-aliases",
      handlerId: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
      phase: "enroll",
      outputs: {
        allowedIds: {
          kind: "config",
          value: "111,222,333,444",
        },
      },
    });
    expect(env.TELEGRAM_ALLOWED_IDS).toBe("111,222,333,444");
  });

  it("does nothing when no canonical or alias allowlist values are present", async () => {
    const env: NodeJS.ProcessEnv = {};
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
        handler: createTelegramAllowlistAliasesHook({ env }),
      },
    ]);

    await expect(
      runMessagingHook(TELEGRAM_ALLOWLIST_ALIASES_HOOK, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      outputs: {},
    });
    expect(env.TELEGRAM_ALLOWED_IDS).toBeUndefined();
  });
});
