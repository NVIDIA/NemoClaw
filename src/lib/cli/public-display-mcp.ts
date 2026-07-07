// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicDisplayLayout } from "./public-display-layout";

export const SANDBOX_MCP_DISPLAY_LAYOUT: Record<string, readonly PublicDisplayLayout[]> = {
  "sandbox:mcp": [
    {
      group: "MCP Servers",
      order: 25.1,
      usage: "nemoclaw <name> mcp list",
      description: "List configured MCP servers",
      flags: "[--json]",
    },
    {
      group: "MCP Servers",
      order: 25.2,
      usage: "nemoclaw <name> mcp add",
      description: "Add an OpenShell-enforced MCP HTTP server",
      flags: "<server> --url <url> --env KEY",
    },
    {
      group: "MCP Servers",
      order: 25.3,
      usage: "nemoclaw <name> mcp status",
      description: "Inspect MCP server health",
      flags: "[server] [--json]",
    },
    {
      group: "MCP Servers",
      order: 25.4,
      usage: "nemoclaw <name> mcp restart",
      description: "Refresh one or all MCP server registrations",
      flags: "[server]",
    },
    {
      group: "MCP Servers",
      order: 25.5,
      usage: "nemoclaw <name> mcp remove",
      description: "Remove an MCP server, provider, and generated policy",
      flags: "<server> [--force]",
    },
  ],
};
