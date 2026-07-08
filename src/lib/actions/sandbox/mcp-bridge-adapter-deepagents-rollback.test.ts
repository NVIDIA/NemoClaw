// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";

describe("Deep Agents MCP config adapter rollback", () => {
  it("restores one legacy entry on rollback without creating the v2 projection", () => {
    const userServer = { type: "stdio", command: "user-owned" };
    const rollback = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
      undefined,
      "legacy",
      { mcpServers: { local: userServer }, ui: { theme: "dark" } },
    );

    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1");
    expect(rollback.configExists).toBe(false);
    expect(rollback.legacyConfig).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
        local: userServer,
      },
      ui: { theme: "dark" },
    });
  });

  it("keeps v2 teardown and rollback isolated from the legacy user file", () => {
    const managedServer = {
      type: "http",
      url: baseEntry.url,
      headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
    };
    const legacyConfig = {
      mcpServers: { local: { type: "stdio", command: "user-owned" } },
      ui: { theme: "dark" },
    };
    const removal = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, false, true),
      { mcpServers: { github: managedServer } },
      "v2",
      legacyConfig,
    );
    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.config).toEqual({ mcpServers: {} });
    expect(removal.legacyConfig).toEqual(legacyConfig);

    const rollback = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
      undefined,
      "v2",
      legacyConfig,
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.config).toEqual({ mcpServers: { github: managedServer } });
    expect(rollback.legacyConfig).toEqual(legacyConfig);
  });

  it("does not apply the v2 server cap to a single-entry legacy rollback", () => {
    const managedEntries = Array.from(
      { length: 65 },
      (_, index): McpBridgeEntry => ({
        ...baseEntry,
        server: `server${String(index)}`,
        env: [`SERVER_${String(index)}_TOKEN`],
      }),
    );

    const rollback = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(managedEntries[0], true, managedEntries, true),
      undefined,
      "legacy",
      { mcpServers: { local: { type: "stdio", command: "user-owned" } } },
    );

    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.legacyConfig).toMatchObject({
      mcpServers: {
        local: { type: "stdio", command: "user-owned" },
        server0: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:SERVER_0_TOKEN" },
        },
      },
    });
  });
});
