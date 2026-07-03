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
  initialConfig?: Record<string, unknown>,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  configExists: boolean;
  config: Record<string, unknown> | null;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-mcp-"));
  const configPath = path.join(tmp, ".deepagents", ".mcp.json");
  const initializeConfig =
    initialConfig === undefined
      ? () => undefined
      : () => {
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, {
            mode: 0o600,
          });
        };
  initializeConfig();
  try {
    const result = spawnSync(
      "bash",
      ["-c", command.replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)],
      { encoding: "utf-8", timeout: 5000 },
    );
    const configExists = fs.existsSync(configPath);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      configExists,
      config: configExists
        ? (JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>)
        : null,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Deep Agents MCP config adapter", () => {
  it("constructs a Deep Agents .mcp.json registration with placeholders", () => {
    const command = buildDeepAgentsMcpRegisterCommand(baseEntry);

    expect(DEEPAGENTS_MCP_CONFIG_PATH).toBe("/sandbox/.deepagents/.mcp.json");
    expect(command).toContain(DEEPAGENTS_MCP_CONFIG_PATH);
    expect(command).not.toContain('pathlib.Path("/sandbox/.mcp.json")');
    expect(command).toContain("mcpServers");
    expect(command).toContain('\\"type\\":\\"http\\"');
    expect(command).toContain("https://api.githubcopilot.com/mcp/");
    expect(command).toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(command).toContain("Invalid /sandbox/.deepagents/.mcp.json");
    expect(command).toContain("mcpServers must be an object");
    expect(command).toContain("already exists in /sandbox/.deepagents/.mcp.json");
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

  it("fails Deep Agents removal on corrupt config unless forced", () => {
    const normal = buildDeepAgentsMcpRemoveCommand(baseEntry);
    const forced = buildDeepAgentsMcpRemoveCommand(baseEntry, true);

    expect(normal).toContain("Invalid /sandbox/.deepagents/.mcp.json");
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

  it("deletes an empty managed file but preserves unrelated Deep Agents config", () => {
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
    expect(withUnrelatedConfig.status, withUnrelatedConfig.stderr).toBe(0);
    expect(withUnrelatedConfig.configExists).toBe(true);
    expect(withUnrelatedConfig.config).toEqual({ ui: { theme: "dark" } });
  });
});
