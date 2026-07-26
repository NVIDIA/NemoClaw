// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isBlockedMcpUrlTargetHost } from "../src/lib/security/mcp-url-target";

describe("MCP URL target special-use filtering", () => {
  it.each([
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.175.48.1",
    "::7f00:1",
    "::a00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:c0a8:101",
    "2001:2::1",
    "2001:20::1",
    "2620:4f:8000::1",
    "3fff::1",
    "5f00::1",
    "fec0::1",
  ])("blocks non-global special-purpose address %s", (address) => {
    expect(isBlockedMcpUrlTargetHost(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
  ])("keeps globally routable address %s eligible", (address) => {
    expect(isBlockedMcpUrlTargetHost(address)).toBe(false);
  });
});
