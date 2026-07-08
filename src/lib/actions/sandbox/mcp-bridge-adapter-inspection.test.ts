// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import { parseAdapterRegistrationInspection } from "./mcp-bridge-adapter-inspection";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("MCP adapter registration inspection", () => {
  it("uses stdout ownership state even when the adapter emits a runtime warning", () => {
    expect(
      parseAdapterRegistrationInspection(
        {
          status: 0,
          stdout: "absent\n",
          stderr: "(node:1200) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
        },
        baseEntry,
      ),
    ).toEqual({ state: "absent" });
  });
});
