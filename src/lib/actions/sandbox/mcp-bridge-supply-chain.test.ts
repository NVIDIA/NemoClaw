// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { enforceTransportTrust } from "./mcp-bridge-supply-chain";

describe("enforceTransportTrust", () => {
  it("rejects an explicit STDIO transport on an HTTPS URL before warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entry: McpSourceEntry = {
        server: "github",
        agent: "openclaw",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        policyName: "mcp-bridge-github",
        transport: "stdio",
      };

      expect(() => enforceTransportTrust(entry, false)).toThrow(/transport mismatch/);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts an explicit SSE transport on an HTTPS URL", () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      policyName: "mcp-bridge-github",
      transport: "sse",
    };

    expect(() => enforceTransportTrust(entry, false)).not.toThrow();
  });

  it("accepts an inferred transport when none is explicitly selected", () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      policyName: "mcp-bridge-github",
    };

    expect(() => enforceTransportTrust(entry, false)).not.toThrow();
  });
});
