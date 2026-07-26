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

describe("Deep Agents MCP config adapter runtime guards", () => {
  it("fails closed without touching either config when the runtime generation is unknown", () => {
    const v2Config = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
      },
    };
    const legacyConfig = {
      mcpServers: { local: { type: "stdio", command: "user-owned" } },
      ui: { theme: "dark" },
    };

    for (const command of [
      buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
    ]) {
      const result = runDeepAgentsConfigCommand(command, v2Config, "unknown", legacyConfig);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Could not identify the managed Deep Agents MCP runtime");
      expect(result.config).toEqual(v2Config);
      expect(result.legacyConfig).toEqual(legacyConfig);
    }
  });

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

  it("does not mutate a legacy file that the v1 runtime would reject", () => {
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

    for (const command of [
      buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
    ]) {
      const result = runDeepAgentsConfigCommand(command, undefined, "legacy", legacyConfig, 0o644);
      expect(result.legacyConfigText).toBe(original);
      expect(result.status === 2 || result.stdout.includes("REMOVAL=unowned")).toBe(true);
    }
  });
});
