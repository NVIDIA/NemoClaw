// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import { buildDeepAgentsMcpRemoveCommand } from "./mcp-bridge-adapter-deepagents";
import { buildDeepAgentsMcpStatusCommand } from "./mcp-bridge-adapter-status";

describe("Deep Agents MCP config adapter v2 removal", () => {
  it("fails Deep Agents removal on corrupt config unless forced", () => {
    const corruptProjection = { mcpServers: [] };
    const normal = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry),
      corruptProjection,
    );
    expect(normal.status).toBe(2);
    expect(normal.stderr).toContain("Invalid managed MCP v2 server map");
    expect(normal.config).toEqual(corruptProjection);

    const forced = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, true),
      corruptProjection,
    );
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=removed");
    expect(forced.config).toEqual({ mcpServers: {} });
  });

  it("treats every extra Deep Agents server field as ownership drift", () => {
    const managedServer = {
      type: "http",
      url: baseEntry.url,
      headers: {
        Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
      },
    };
    const driftedConfig = {
      mcpServers: {
        github: {
          ...managedServer,
          allowedTools: ["get_issue"],
        },
      },
    };

    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      driftedConfig,
    );
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.trim()).toBe("mismatch");

    const remove = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry),
      driftedConfig,
    );
    expect(remove.status).toBe(2);
    expect(remove.stderr).toContain("Refusing to remove modified MCP server 'github'");
    expect(remove.config).toEqual(driftedConfig);
  });

  it("writes an empty tombstone and refuses unrelated state unless forced", () => {
    const managedServer = {
      type: "http",
      url: baseEntry.url,
      headers: {
        Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
      },
    };
    const onlyManagedServer = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry),
      { mcpServers: { github: managedServer } },
    );
    expect(onlyManagedServer.status, onlyManagedServer.stderr).toBe(0);
    expect(onlyManagedServer.config).toEqual({ mcpServers: {} });

    const withUnrelatedConfig = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry),
      {
        mcpServers: { github: managedServer },
        ui: { theme: "dark" },
      },
    );
    expect(withUnrelatedConfig.status).toBe(2);
    expect(withUnrelatedConfig.configExists).toBe(true);
    expect(withUnrelatedConfig.config).toEqual({
      mcpServers: { github: managedServer },
      ui: { theme: "dark" },
    });

    const forced = runDeepAgentsConfigCommand(buildDeepAgentsMcpRemoveCommand(baseEntry, true), {
      mcpServers: { github: managedServer },
      ui: { theme: "dark" },
    });
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.config).toEqual({ mcpServers: {} });
  });
});
