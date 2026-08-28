// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../src/lib/state/registry";

export const mcpDestroyBridgeEntries: Record<"github" | "slack", McpBridgeEntry> = {
  github: {
    server: "github",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://8.8.8.8/github",
    env: ["GITHUB_TOKEN"],
    providerName: "alpha-mcp-github",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-github",
    addedAt: "2026-06-27T00:00:00.000Z",
  },
  slack: {
    server: "slack",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://8.8.8.8/slack",
    env: ["SLACK_TOKEN"],
    providerName: "alpha-mcp-slack",
    providerId: "66666666-7777-4888-8999-000000000000",
    policyName: "mcp-bridge-slack",
    addedAt: "2026-06-27T00:00:00.000Z",
  },
};
