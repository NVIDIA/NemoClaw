// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import type { ChannelHookSpec } from "../../../manifest";
import {
  createTelegramGetMeReachabilityHook,
  TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
} from "./get-me-reachability";

const TELEGRAM_REACHABILITY_HOOK = {
  id: "telegram-reachability",
  phase: "reachability-check",
  handler: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
  inputs: ["botToken"],
  onFailure: "skip-channel",
} as const satisfies ChannelHookSpec;

describe("Telegram getMe reachability hook implementation", () => {
  it("calls Telegram getMe without exposing the token in outputs", async () => {
    const urls: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          apiBaseUrl: "https://telegram.test",
          fetch: async (url) => {
            urls.push(url);
            return {
              ok: true,
              status: 200,
              async json() {
                return { ok: true, result: { id: 42, is_bot: true } };
              },
              async text() {
                return "";
              },
            };
          },
        }),
      },
    ]);
    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "123456:telegram-token",
        },
      }),
    ).resolves.toEqual({
      hookId: "telegram-reachability",
      handlerId: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
      phase: "reachability-check",
      outputs: {},
    });
    expect(urls).toEqual(["https://telegram.test/bot123456:telegram-token/getMe"]);
  });

  it("fails so the compiler can skip the channel when Telegram rejects the token", async () => {
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          log: (message) => logs.push(message),
          fetch: async () => ({
            ok: false,
            status: 404,
            statusText: "Not Found",
            async json() {
              return { ok: false };
            },
            async text() {
              return "unauthorized";
            },
          }),
        }),
      },
    ]);
    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "bad-token",
        },
      }),
    ).rejects.toThrow("Telegram bot token was rejected.");
    expect(logs).toEqual([
      "  ⚠ Bot token was rejected by Telegram — verify the token is correct.",
      [
        "  Telegram integration will be disabled for this enrollment run because",
        "the bot token was rejected by Telegram.",
      ].join(" "),
    ]);
  });

  it("fails so the compiler can skip the channel when non-interactive Bot API requests fail", async () => {
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          log: (message) => logs.push(message),
          fetch: async () => {
            throw new Error("network unavailable");
          },
        }),
      },
    ]);
    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        isInteractive: false,
        inputs: {
          botToken: "123456:telegram-token",
        },
      }),
    ).rejects.toThrow("Telegram reachability check failed: Bot API request failed.");
    expect(logs).toEqual([
      [
        "  Telegram integration will be disabled for this enrollment run because",
        "api.telegram.org is unreachable.",
      ].join(" "),
    ]);
  });

  it("bounds hung Bot API requests with a timeout", async () => {
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          log: (message) => logs.push(message),
          timeoutMs: 1,
          fetch: async () => new Promise(() => {}),
        }),
      },
    ]);

    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "123456:telegram-token",
        },
      }),
    ).resolves.toMatchObject({
      hookId: "telegram-reachability",
      outputs: {},
    });
    expect(logs).toEqual(["  ⚠ Telegram reachability check failed: Bot API request failed."]);
  });

  it("honors the explicit skip env without calling Telegram", async () => {
    const urls: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          env: {
            NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
          },
          fetch: async (url) => {
            urls.push(url);
            throw new Error("fetch should not run");
          },
        }),
      },
    ]);

    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "123456:telegram-token",
        },
      }),
    ).resolves.toMatchObject({
      hookId: "telegram-reachability",
      outputs: {},
    });
    expect(urls).toEqual([]);
  });
});
