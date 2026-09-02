// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";
import { buildDeepAgentsMcpStatusCommand } from "./mcp-bridge-adapter-status";

describe("Deep Agents MCP config adapter runtime guards", () => {
  const managedServer = {
    type: "http",
    url: baseEntry.url,
    headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
  };
  const userServer = { type: "stdio", command: "user-owned" };
  const registeredV2Config = { mcpServers: { github: managedServer } };
  const registeredLegacyConfig = {
    mcpServers: { github: managedServer, local: userServer },
    ui: { theme: "dark" },
  };
  const driftedLegacyConfig = {
    mcpServers: { github: { type: "http", url: "https://user.example/mcp" } },
  };
  const emptyV2Config = { mcpServers: {} };
  const emptyLegacyConfig = {
    mcpServers: { local: userServer },
    ui: { theme: "dark" },
  };
  const statusCommand = buildDeepAgentsMcpStatusCommand(baseEntry);
  const removalCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true, true);
  const rollbackCommand = buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true);
  const runtimeSelectionCases = [
    ["status", "v2", statusCommand, registeredV2Config, driftedLegacyConfig, [0, "registered", "", true, true]],
    ["status", "legacy", statusCommand, registeredV2Config, driftedLegacyConfig, [0, "mismatch", "", true, true]],
    ["status", "unknown", statusCommand, registeredV2Config, driftedLegacyConfig, [2, "", "Could not identify the managed Deep Agents MCP runtime", true, true]],
    ["adaptive teardown", "v2", removalCommand, registeredV2Config, registeredLegacyConfig, [0, "NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=removed", "", false, true]],
    ["adaptive teardown", "legacy", removalCommand, registeredV2Config, registeredLegacyConfig, [0, "NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=removed", "", true, false]],
    ["adaptive teardown", "unknown", removalCommand, registeredV2Config, registeredLegacyConfig, [2, "", "Could not identify the managed Deep Agents MCP runtime; refusing teardown", true, true]],
    ["rollback", "v2", rollbackCommand, emptyV2Config, emptyLegacyConfig, [0, "NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1", "", true, false]],
    ["rollback", "legacy", rollbackCommand, emptyV2Config, emptyLegacyConfig, [0, "NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1", "", false, true]],
    ["rollback", "unknown", rollbackCommand, emptyV2Config, emptyLegacyConfig, [2, "", "Could not identify the managed Deep Agents MCP runtime; refusing rollback", false, false]],
  ] as const;
  const hasGithubServer = (config: Record<string, unknown> | null): boolean => {
    const servers = config?.mcpServers;
    return typeof servers === "object" && servers !== null && Object.hasOwn(servers, "github");
  };

  it.each(runtimeSelectionCases)(
    "uses the shared runtime marker for %s: %s",
    (_operation, runtimeKind, command, initialConfig, initialLegacyConfig, expected) => {
      const result = runDeepAgentsConfigCommand(
        command,
        initialConfig,
        runtimeKind,
        initialLegacyConfig,
      );

      expect([
        result.status,
        result.stdout.trim(),
        result.stderr.trim(),
        hasGithubServer(result.config),
        hasGithubServer(result.legacyConfig),
      ]).toEqual(expected);
    },
  );

  it("preserves ambiguous legacy JSON byte-for-byte during teardown and rollback", () => {
    const exactServer = JSON.stringify({
      type: "http",
      url: baseEntry.url,
      headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
    });
    const duplicateConfig =
      `{"mcpServers":{"local":{"type":"stdio","command":"first"}},` +
      `"mcpServers":{"github":${exactServer},"local":{"type":"stdio","command":"second"}},` +
      `"ui":{"theme":"dark"}}\n`;

    const removal = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
      undefined,
      "legacy",
      duplicateConfig,
    );
    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.stdout.trim()).toBe("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=unowned");
    expect(removal.legacyConfigText).toBe(duplicateConfig);

    const rollback = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
      undefined,
      "legacy",
      duplicateConfig,
    );
    expect(rollback.status).toBe(2);
    expect(rollback.stderr).toContain("duplicate JSON key: mcpServers");
    expect(rollback.legacyConfigText).toBe(duplicateConfig);
  });

  it.each(
    Array.from(
      [
        buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
        buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
      ],
      (value) => [value],
    ),
  )("does not mutate a legacy file that the v1 runtime would reject [case %#]", (command) => {
    const legacyConfig = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
      },
      ui: { theme: "dark" },
    };
    const original = `${JSON.stringify(legacyConfig, null, 2)}\n`;

    const result = runDeepAgentsConfigCommand(command, undefined, "legacy", legacyConfig, 0o644);
    expect(result.legacyConfigText).toBe(original);
    expect(result.status === 2 || result.stdout.includes("REMOVAL=unowned")).toBe(true);
  });
});
