// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveDiscordTemplateReference } from "../dist/lib/messaging/channels/discord/template-resolver.js";

// OpenClaw's Discord plugin validates channels.discord.accounts.default.proxy
// and rejects any non-loopback host (validateDiscordProxyUrl: "Proxy URL must
// target a loopback host"). The sandbox egress proxy (10.200.0.1:3128) is not
// loopback, so a per-account proxy must NOT be emitted; Discord gateway/REST
// egress is carried by the top-level managed proxy (proxy.loopbackMode:
// "gateway-only") instead. discordProxyUrl therefore resolves to undefined so
// the proxy field is dropped from the rendered config (#5544; reverts #5248).
const ctx = (env: Record<string, string | undefined>) => ({ inputs: [], env });

describe("discord template-resolver: discordProxyUrl", () => {
  it("resolves to undefined so no per-account proxy is emitted (#5544)", () => {
    expect(resolveDiscordTemplateReference("discordProxyUrl", ctx({}))).toEqual({
      matched: true,
      value: undefined,
    });
  });

  it("stays undefined even when NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT are set", () => {
    expect(
      resolveDiscordTemplateReference(
        "discordProxyUrl",
        ctx({ NEMOCLAW_PROXY_HOST: "10.201.0.9", NEMOCLAW_PROXY_PORT: "43128" }),
      ),
    ).toEqual({ matched: true, value: undefined });
  });
});
