// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseAndValidateSandboxPolicy } from "./sandbox-policy-validation";

function policyWithMcpOptions(options: Record<string, unknown>) {
  return {
    version: 1,
    network_policies: {
      mcp_bridge_fake: {
        name: "MCP fixture",
        binaries: [{ path: "/usr/bin/node" }],
        endpoints: [
          {
            host: "mcp.example.test",
            port: 443,
            protocol: "mcp",
            mcp: { allow_all_known_mcp_methods: true, ...options },
          },
        ],
      },
    },
  };
}

describe("MCP policy version preservation during rebuild", () => {
  it.each([
    {},
    { versions: ["2025-03-26"] },
    { versions: ["2025-06-18"] },
    { versions: ["2025-11-25"] },
    { versions: ["2026-07-28"] },
    { versions: ["2025-11-25", "2025-03-26", "2025-06-18", "2026-07-28"] },
  ])("preserves supported MCP options %j", (options) => {
    const policy = policyWithMcpOptions(options);
    expect(parseAndValidateSandboxPolicy(JSON.stringify(policy))).toEqual(policy);
  });

  it.each([
    { versions: [] },
    { versions: null },
    { versions: "2025-11-25" },
    { versions: ["2025-11-25", "2025-11-25"] },
    { versions: ["2025-11-26"] },
    { versions: [" 2025-11-25"] },
    { versions: ["2025-11-25 "] },
    { versions: [20251125] },
    { unknown_option: true },
  ])("rejects invalid MCP options %j", (options) => {
    expect(() =>
      parseAndValidateSandboxPolicy(JSON.stringify(policyWithMcpOptions(options))),
    ).toThrow("does not satisfy the shipped sandbox policy schema");
  });
});
