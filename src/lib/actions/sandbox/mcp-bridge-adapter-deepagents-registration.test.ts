// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import type { McpBridgeEntry } from "../../state/registry";
import { buildDeepAgentsMcpRegisterCommand } from "./mcp-bridge-adapter-deepagents";
import { DEEPAGENTS_MCP_CONFIG_PATH } from "./mcp-bridge-adapter-status";

describe("Deep Agents MCP config adapter registration", () => {
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

  it("rejects an oversized rendered projection before truncating existing state", () => {
    const initialConfig = { mcpServers: {} };
    const oversized = buildDeepAgentsMcpRegisterCommand(baseEntry).replace(
      "data = {'mcpServers': payload['expectedServers']}",
      "data = {'mcpServers': {'oversized': {'blob': 'x' * 300000}}}",
    );
    const registration = runDeepAgentsConfigCommand(oversized, initialConfig);

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("invalid rendered size");
    expect(registration.config).toEqual(initialConfig);
  });
});
