// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import { buildDeepAgentsMcpRemoveCommand } from "./mcp-bridge-adapter-deepagents";

describe("Deep Agents MCP config adapter legacy teardown", () => {
  it("surgically removes an exact legacy entry and preserves user-owned content", () => {
    const managedServer = {
      type: "http",
      url: baseEntry.url,
      headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
    };
    const userServer = { type: "stdio", command: "user-owned" };
    const legacyConfig = {
      mcpServers: { github: managedServer, local: userServer },
      ui: { theme: "dark" },
    };

    const removal = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, false, true),
      undefined,
      "legacy",
      legacyConfig,
    );

    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=removed");
    expect(removal.configExists).toBe(false);
    expect(removal.legacyConfig).toEqual({
      mcpServers: { local: userServer },
      ui: { theme: "dark" },
    });
  });

  it("treats legacy absence as proved and refuses drift unless force can remove one slot", () => {
    const userServer = { type: "stdio", command: "user-owned" };
    const absentConfig = { mcpServers: { local: userServer }, ui: { theme: "dark" } };
    const absent = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, false, true),
      undefined,
      "legacy",
      absentConfig,
    );
    expect(absent.status, absent.stderr).toBe(0);
    expect(absent.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=absent");
    expect(absent.legacyConfig).toEqual(absentConfig);

    const driftedConfig = {
      mcpServers: {
        github: { type: "http", url: "https://user.example/mcp" },
        local: userServer,
      },
      ui: { theme: "dark" },
    };
    const refused = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, false, true),
      undefined,
      "legacy",
      driftedConfig,
    );
    expect(refused.status, refused.stderr).toBe(0);
    expect(refused.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=unowned");
    expect(refused.legacyConfig).toEqual(driftedConfig);

    const forced = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
      undefined,
      "legacy",
      driftedConfig,
    );
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=removed");
    expect(forced.legacyConfig).toEqual({
      mcpServers: { local: userServer },
      ui: { theme: "dark" },
    });
  });
});
