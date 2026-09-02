// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mcpTeardownPoliciesMatch } from "./mcp-bridge-rebuild";

describe("MCP rebuild policy handoff comparison", () => {
  it("treats equivalent OpenShell metadata and formatting as unchanged", () => {
    const compact = [
      "Version: 7",
      "Hash: sha256:old-rendering",
      "---",
      "version: 1",
      "network_policies:",
      "  mcp_bridge_github: { name: mcp_bridge_github }",
      "",
    ].join("\n");
    const expanded = [
      "Hash: sha256:new-rendering",
      "Version: 99",
      "---",
      "version: 1",
      "network_policies:",
      "  mcp_bridge_github:",
      "    name: mcp_bridge_github",
      "",
    ].join("\n");

    expect(mcpTeardownPoliciesMatch(compact, expanded)).toBe(true);
  });

  it("fails closed on malformed policy text so teardown cannot proceed", () => {
    expect(
      mcpTeardownPoliciesMatch(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies: [\n",
      ),
    ).toBe(false);
  });
});
