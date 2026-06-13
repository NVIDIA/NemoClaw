// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveDiscordTemplateReference } from "../dist/lib/messaging/channels/discord/template-resolver.js";

// The Discord gateway client honors only the per-account proxy (it ignores the
// managed env proxy), so channels.discord.accounts.default.proxy must resolve to
// the sandbox proxy or the gateway WebSocket cannot egress the deny-by-default
// network namespace. Telegram already resolves its proxy this way; #5075.
const ctx = (env: Record<string, string | undefined>) => ({ inputs: [], env });

describe("discord template-resolver: discordProxyUrl", () => {
  it("resolves discordProxyUrl to the default sandbox proxy (was previously undefined, #5075)", () => {
    expect(resolveDiscordTemplateReference("discordProxyUrl", ctx({}))).toEqual({
      matched: true,
      value: "http://10.200.0.1:3128",
    });
  });

  it("honors NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT overrides", () => {
    expect(
      resolveDiscordTemplateReference(
        "discordProxyUrl",
        ctx({ NEMOCLAW_PROXY_HOST: "10.201.0.9", NEMOCLAW_PROXY_PORT: "43128" }),
      ),
    ).toEqual({ matched: true, value: "http://10.201.0.9:43128" });
  });
});
