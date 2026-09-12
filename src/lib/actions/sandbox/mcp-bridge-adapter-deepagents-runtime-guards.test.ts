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
import { buildDeepAgentsMcpRuntimeKindCommand } from "./mcp-bridge-adapter-status";

describe("Deep Agents MCP config adapter runtime guards", () => {
  it.each([
    {
      runtimeKind: "v2" as const,
      expectedManaged: { mcpServers: {} },
      expectedLegacy: { mcpServers: { github: { type: "http", url: baseEntry.url } } },
    },
    {
      runtimeKind: "legacy" as const,
      expectedManaged: { mcpServers: { github: { type: "http", url: baseEntry.url } } },
      expectedLegacy: null,
    },
  ])(
    "uses the same $runtimeKind runtime classification for repair probes and adaptive teardown (#10756)",
    ({ runtimeKind, expectedManaged, expectedLegacy }) => {
      const config = { mcpServers: { github: { type: "http", url: baseEntry.url } } };
      const detection = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpRuntimeKindCommand(),
        config,
        runtimeKind,
        config,
      );
      const removal = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
        config,
        runtimeKind,
        config,
      );

      expect(detection.status, detection.stderr).toBe(0);
      expect(detection.stdout.trim()).toBe(runtimeKind);
      expect(removal.status, removal.stderr).toBe(0);
      expect(removal.config).toEqual(expectedManaged);
      expect(removal.legacyConfig).toEqual(expectedLegacy);
    },
  );

  it.each([
    {
      runtimeKind: "v2" as const,
      initialManaged: { mcpServers: {} },
      initialLegacy: { mcpServers: { local: { type: "stdio", command: "user-owned" } } },
      expectedManaged: {
        mcpServers: {
          github: {
            type: "http",
            url: baseEntry.url,
            headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
          },
        },
      },
      expectedLegacy: { mcpServers: { local: { type: "stdio", command: "user-owned" } } },
    },
    {
      runtimeKind: "legacy" as const,
      initialManaged: undefined,
      initialLegacy: { mcpServers: {} },
      expectedManaged: null,
      expectedLegacy: {
        mcpServers: {
          github: {
            type: "http",
            url: baseEntry.url,
            headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
          },
        },
      },
    },
  ])(
    "uses the shared runtime classifier for $runtimeKind rollback (#10756)",
    ({ runtimeKind, initialManaged, initialLegacy, expectedManaged, expectedLegacy }) => {
      const rollback = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
        initialManaged,
        runtimeKind,
        initialLegacy,
      );

      expect(rollback.status, rollback.stderr).toBe(0);
      expect(rollback.config).toEqual(expectedManaged);
      expect(rollback.legacyConfig).toEqual(expectedLegacy);
    },
  );

  it.each(
    Array.from(
      [
        buildDeepAgentsMcpRemoveCommand(baseEntry, true, true),
        buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true),
      ],
      (value) => [value],
    ),
  )(
    "fails closed without touching either config when the runtime generation is unknown [case %#]",
    (command) => {
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

      const result = runDeepAgentsConfigCommand(command, v2Config, "unknown", legacyConfig);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Could not identify the managed Deep Agents MCP runtime");
      expect(result.config).toEqual(v2Config);
      expect(result.legacyConfig).toEqual(legacyConfig);
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
