// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mcpPolicyAllowedIps } from "./mcp-policy-pins";

describe("MCP policy pin test helper", () => {
  it("returns string address pins from the selected MCP policy", () => {
    expect(
      mcpPolicyAllowedIps(
        [
          "network_policies:",
          "  mcp_bridge_example:",
          "    endpoints:",
          "      - allowed_ips:",
          "          - 1.1.1.1",
          "          - 8.8.8.8",
        ].join("\n"),
        "example",
      ),
    ).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it.each(["", "network_policies: {}", "network_policies:\n  mcp_bridge_example: {}"])(
    "identifies the policy and server when the expected pin shape is absent [%s]",
    (content) => {
      expect(() => mcpPolicyAllowedIps(content, "example")).toThrow(
        "MCP policy 'mcp_bridge_example' for server 'example' has no first endpoint with string allowed_ips.",
      );
    },
  );
});
