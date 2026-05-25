// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import { telegramManifest } from "../manifest";
import {
  FAKE_TELEGRAM_HOOK_REGISTRATIONS,
  TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
} from "./fakes";

describe("Telegram fake hook implementations", () => {
  it("declares the reachability hook without exposing the token in outputs", async () => {
    const registry = new MessagingHookRegistry(FAKE_TELEGRAM_HOOK_REGISTRATIONS);
    const hook = telegramManifest.hooks.find((entry) => entry.phase === "reachability-check");

    if (!hook) throw new Error("missing Telegram reachability hook");

    await expect(
      runMessagingHook(hook, registry, {
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
  });
});
