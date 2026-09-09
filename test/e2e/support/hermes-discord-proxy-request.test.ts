// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { hermesDiscordHttpProxyWebSocketUrl } from "../live/hermes-discord-proxy.ts";

describe("Hermes Discord proxy request", () => {
  it("uses HTTP absolute-form for the native WebSocket upgrade through OpenShell", () => {
    const gateway = new URL(hermesDiscordHttpProxyWebSocketUrl("host.openshell.internal", 32_768));

    expect(gateway.href).toBe("http://host.openshell.internal:32768/gateway");
  });
});
