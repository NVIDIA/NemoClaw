// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildPublicTunnelProbeArgs } from "../live/mcp-bridge-servers.ts";

describe("MCP bridge public tunnel readiness", () => {
  it("builds a bounded HTTPS-only curl probe", () => {
    expect(buildPublicTunnelProbeArgs("https://fixture-cleanup-123.trycloudflare.com/mcp")).toEqual(
      [
        "--disable",
        "--silent",
        "--show-error",
        "--head",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--connect-timeout",
        "5",
        "--max-time",
        "5",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "https://fixture-cleanup-123.trycloudflare.com/mcp",
      ],
    );
  });
});
