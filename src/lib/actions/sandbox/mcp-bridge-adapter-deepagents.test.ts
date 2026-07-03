// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";
import {
  buildDeepAgentsMcpStatusCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
} from "./mcp-bridge-adapter-status";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "langchain-deepagents-code",
  adapter: "deepagents-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

function runDeepAgentsConfigCommand(
  command: string,
  initialConfig?: Record<string, unknown> | string,
  runtimeKind: "v2" | "legacy" | "unknown" = "v2",
  initialLegacyConfig?: Record<string, unknown> | string,
  initialLegacyMode = 0o600,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  configExists: boolean;
  config: Record<string, unknown> | null;
  configText: string | null;
  legacyConfigExists: boolean;
  legacyConfig: Record<string, unknown> | null;
  legacyConfigText: string | null;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-mcp-"));
  const configPath = path.join(tmp, ".deepagents", ".nemoclaw-mcp.json");
  const legacyConfigPath = path.join(tmp, ".deepagents", ".mcp.json");
  const initializeConfig = (
    target: string,
    value: Record<string, unknown> | string | undefined,
  ) => {
    if (value === undefined) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  initializeConfig(configPath, initialConfig);
  initializeConfig(legacyConfigPath, initialLegacyConfig);
  if (initialLegacyConfig !== undefined) fs.chmodSync(legacyConfigPath, initialLegacyMode);
  try {
    const fixtureCommand = command
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", "python3")
      .replace(
        'runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR',
        `runtime_kind = "${runtimeKind}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
      );
    const result = spawnSync("bash", ["-c", fixtureCommand], { encoding: "utf-8", timeout: 5000 });
    const configExists = fs.existsSync(configPath);
    const legacyConfigExists = fs.existsSync(legacyConfigPath);
    const configText = configExists ? fs.readFileSync(configPath, "utf-8") : null;
    const legacyConfigText = legacyConfigExists ? fs.readFileSync(legacyConfigPath, "utf-8") : null;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      configExists,
      config: configText ? (JSON.parse(configText) as Record<string, unknown>) : null,
      configText,
      legacyConfigExists,
      legacyConfig: legacyConfigText
        ? (JSON.parse(legacyConfigText) as Record<string, unknown>)
        : null,
      legacyConfigText,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Deep Agents MCP config adapter", () => {
  it("constructs a dedicated NemoClaw MCP projection with placeholders", () => {
    const command = buildDeepAgentsMcpRegisterCommand(baseEntry);

    expect(DEEPAGENTS_MCP_CONFIG_PATH).toBe("/sandbox/.deepagents/.nemoclaw-mcp.json");
    expect(command).toContain(DEEPAGENTS_MCP_CONFIG_PATH);
    expect(command).not.toContain('pathlib.Path("/sandbox/.mcp.json")');
    expect(command).toContain("mcpServers");
    expect(command).toContain('\\"type\\":\\"http\\"');
    expect(command).toContain("https://api.githubcopilot.com/mcp/");
    expect(command).toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(command).toContain("Invalid /sandbox/.deepagents/.nemoclaw-mcp.json");
    expect(command).toContain("mcpServers must be an object");
    expect(command).toContain("already exists in /sandbox/.deepagents/.nemoclaw-mcp.json");
  });

  it("creates the Deep Agents config parent on first registration", () => {
    const registration = runDeepAgentsConfigCommand(buildDeepAgentsMcpRegisterCommand(baseEntry));

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configExists).toBe(true);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: {
            Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
          },
        },
      },
    });
  });

  it("rejects unowned config before registration mutates the file", () => {
    const initialConfig = { ui: { theme: "dark" } };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry),
      initialConfig,
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("only mcpServers is allowed");
    expect(registration.config).toEqual(initialConfig);
  });

  it("renders the complete registry-owned server projection", () => {
    const jiraEntry: McpBridgeEntry = {
      ...baseEntry,
      server: "jira",
      url: "https://mcp.atlassian.com/v1/",
      env: ["JIRA_MCP_TOKEN"],
      providerName: "alpha-mcp-jira",
      policyName: "mcp-bridge-jira",
    };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(jiraEntry, false, [baseEntry, jiraEntry]),
      {
        mcpServers: {
          github: {
            type: "http",
            url: baseEntry.url,
            headers: {
              Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
            },
          },
        },
      },
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
        jira: {
          type: "http",
          url: jiraEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:JIRA_MCP_TOKEN" },
        },
      },
    });
  });

  it("rejects a 65-server projection before rendering a mutation command", () => {
    const managedEntries = Array.from(
      { length: 65 },
      (_, index): McpBridgeEntry => ({
        ...baseEntry,
        server: `server${String(index)}`,
        env: [`SERVER_${String(index)}_TOKEN`],
        providerName: `alpha-mcp-server-${String(index)}`,
        policyName: `mcp-bridge-server-${String(index)}`,
      }),
    );

    expect(() =>
      buildDeepAgentsMcpRegisterCommand(managedEntries[0], false, managedEntries),
    ).toThrow(/at most 64 servers.*refusing to render a 65-server mutation/);
    expect(() =>
      buildDeepAgentsMcpRegisterCommand(managedEntries[0], false, managedEntries.slice(0, 64)),
    ).not.toThrow();
  });

  it("fails Deep Agents removal on corrupt config unless forced", () => {
    const normal = buildDeepAgentsMcpRemoveCommand(baseEntry);
    const forced = buildDeepAgentsMcpRemoveCommand(baseEntry, true);

    expect(normal).toContain("Invalid managed MCP v2 projection");
    expect(normal).toContain('\\"force\\":false');
    expect(normal).toContain("raise SystemExit(2)");
    expect(normal).toContain("Refusing to remove modified MCP server");
    expect(forced).toContain('\\"force\\":true');
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

  it("deletes an empty projection and refuses unrelated state unless forced", () => {
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
    expect(onlyManagedServer.configExists).toBe(false);

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
    expect(forced.configExists).toBe(false);
  });

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
    expect(removal.configExists).toBe(false);
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
