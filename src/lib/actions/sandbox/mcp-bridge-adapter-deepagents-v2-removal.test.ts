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
  it("inspects the installed legacy runtime projection", () => {
    const legacyConfig = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    };
    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "legacy",
      legacyConfig,
    );

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.trim()).toBe("registered");
  });

  it("reports an unknown installed runtime as an inspection failure", () => {
    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "unknown",
    );

    expect(status.status).toBe(2);
    expect(status.stderr).toContain("Could not identify the managed Deep Agents MCP runtime");
    expect(status.stdout.trim()).toBe("");
  });

  it("reports unsafe legacy state as an inspection failure instead of absence", () => {
    const legacyConfig = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    };
    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "legacy",
      legacyConfig,
      0o644,
    );

    expect(status.status).toBe(2);
    expect(status.stderr).toContain("legacy MCP config has unsafe ownership, mode, type, or links");
    expect(status.stdout.trim()).toBe("");
  });

  it("recognizes and removes an exact revision-scoped managed credential", () => {
    const revisionedConfig = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    };

    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      revisionedConfig,
    );
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.trim()).toBe("registered");

    const removal = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRemoveCommand(baseEntry),
      revisionedConfig,
    );
    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.config).toEqual({ mcpServers: {} });
  });

  it("requires the exact revision when registration supplies one", () => {
    const status = runDeepAgentsConfigCommand(buildDeepAgentsMcpStatusCommand(baseEntry, "v12"), {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
          },
        },
      },
    });

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.trim()).toBe("mismatch");
  });

  it.each([
    "Bearer openshell:resolve:env:v_GITHUB_TOKEN",
    "Bearer openshell:resolve:env:v12_OTHER_TOKEN",
    `Bearer openshell:resolve:env:v${"1".repeat(21)}_GITHUB_TOKEN`,
    "Bearer raw-credential",
  ])("rejects an invalid revision-scoped ownership claim: %s", (authorization) => {
    const config = {
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: authorization },
        },
      },
    };
    const status = runDeepAgentsConfigCommand(buildDeepAgentsMcpStatusCommand(baseEntry), config);
    const removal = runDeepAgentsConfigCommand(buildDeepAgentsMcpRemoveCommand(baseEntry), config);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.trim()).toBe("mismatch");
    expect(removal.status).toBe(2);
    expect(removal.config).toEqual(config);
  });

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
