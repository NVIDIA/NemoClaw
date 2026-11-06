// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveDiscordTemplateReference } from "../../../src/lib/messaging/channels/discord/template-resolver.js";

// Discord uses OpenShell native egress. Obsolete proxy inputs must not create
// an account-level proxy configuration.
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
