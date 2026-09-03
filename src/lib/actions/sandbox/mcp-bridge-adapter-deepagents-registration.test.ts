// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import type { McpBridgeEntry } from "../../state/registry";
import { buildDeepAgentsMcpRegisterCommand } from "./mcp-bridge-adapter-deepagents";
import { restoreDeepAgentsManagedMcpProjection } from "./mcp-bridge-adapter-deepagents-registration";
import { buildDeepAgentsMcpRuntimeKindCommand } from "./mcp-bridge-adapter-status";
import { executeSandboxCommand } from "./process-recovery";

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: vi.fn(),
}));

const executeSandboxCommandMock = vi.mocked(executeSandboxCommand);

function jiraEntry(): McpBridgeEntry {
  return {
    ...baseEntry,
    server: "jira",
    url: "https://mcp.atlassian.com/v1/",
    env: ["JIRA_MCP_TOKEN"],
    providerName: "alpha-mcp-jira",
    policyName: "mcp-bridge-jira",
  };
}

beforeEach(() => {
  executeSandboxCommandMock.mockReset();
});

describe("Deep Agents MCP config adapter registration", () => {
  it("writes only the dedicated managed projection with a credential placeholder", () => {
    const legacyConfig = { mcpServers: { user: { command: "user-command" } } };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry),
      undefined,
      "v2",
      legacyConfig,
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configIsRegularFile).toBe(true);
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
    expect(registration.legacyConfig).toEqual(legacyConfig);
  });

  it("creates a missing Deep Agents config parent during snapshot repair (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetManagedProjection: true,
      }),
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configIsRegularFile).toBe(true);
    expect(registration.configMode).toBe(0o600);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    });
  });

  it("publishes the readiness-proven credential revision without a raw credential", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, false, [baseEntry], false, "v12"),
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    });
    expect(registration.configText).not.toContain("host-only-secret");
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

  it("replaces an unsafe symbolic link during snapshot restore without following it (#10756)", () => {
    const initialConfig = { mcpServers: {} };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetManagedProjection: true,
      }),
      initialConfig,
      "v2",
      undefined,
      0o600,
      { symlink: true },
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configIsRegularFile).toBe(true);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    });
    expect(registration.managedSymlinkTargetText).toBe(
      `${JSON.stringify(initialConfig, null, 2)}\n`,
    );
  });

  it("replaces an unsafe FIFO during snapshot restore without opening it (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetManagedProjection: true,
      }),
      { mcpServers: {} },
      "v2",
      undefined,
      0o600,
      { fifo: true },
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configIsRegularFile).toBe(true);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    });
  });

  it("replaces an unsafe dangling symlink during snapshot restore (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetManagedProjection: true,
      }),
      undefined,
      "v2",
      undefined,
      0o600,
      { danglingSymlink: true },
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.configIsRegularFile).toBe(true);
    expect(registration.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: {
            Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
          },
        },
      },
    });
    expect(registration.managedSymlinkTargetExists).toBe(false);
  });

  it("preserves a directory at the managed projection path for operator recovery (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetManagedProjection: true,
      }),
      undefined,
      "v2",
      undefined,
      0o600,
      { directory: true },
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("managed MCP projection path is a directory");
    expect(registration.managedDirectoryEntries).toEqual(["preserved.txt"]);
  });

  it.each([
    { label: "symbolic link", managedOptions: { symlink: true } },
    { label: "FIFO", managedOptions: { fifo: true } },
  ])(
    "replaces an unsafe $label with an empty managed projection when the registry is empty (#10756)",
    ({ managedOptions }) => {
      const initialConfig = { mcpServers: { unmanaged: { command: "unmanaged" } } };
      const registration = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpRegisterCommand(undefined, true, [], false, undefined, {
          resetManagedProjection: true,
        }),
        initialConfig,
        "v2",
        undefined,
        0o600,
        managedOptions,
      );

      expect(registration.status, registration.stderr).toBe(0);
      expect(registration.configIsRegularFile).toBe(true);
      expect(registration.config).toEqual({ mcpServers: {} });
    },
  );

  it("preserves a directory when the empty registry requires projection reset (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(undefined, true, [], false, undefined, {
        resetManagedProjection: true,
      }),
      undefined,
      "v2",
      undefined,
      0o600,
      { directory: true },
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("managed MCP projection path is a directory");
    expect(registration.managedDirectoryEntries).toEqual(["preserved.txt"]);
  });

  it("preserves a sibling revision while revising the target server", () => {
    const jiraEntry: McpBridgeEntry = {
      ...baseEntry,
      server: "jira",
      url: "https://mcp.atlassian.com/v1/",
      env: ["JIRA_MCP_TOKEN"],
      providerName: "alpha-mcp-jira",
      policyName: "mcp-bridge-jira",
    };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(jiraEntry, false, [baseEntry, jiraEntry], false, "v12"),
      {
        mcpServers: {
          github: {
            type: "http",
            url: baseEntry.url,
            headers: {
              Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
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
          headers: { Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN" },
        },
        jira: {
          type: "http",
          url: jiraEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:v12_JIRA_MCP_TOKEN" },
        },
      },
    });
  });

  it("rejects a missing registry sibling before changing the target server", () => {
    const jiraEntry: McpBridgeEntry = {
      ...baseEntry,
      server: "jira",
      url: "https://mcp.atlassian.com/v1/",
      env: ["JIRA_MCP_TOKEN"],
      providerName: "alpha-mcp-jira",
      policyName: "mcp-bridge-jira",
    };
    const initialConfig = { mcpServers: {} };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(jiraEntry, false, [baseEntry, jiraEntry], false, "v12"),
      initialConfig,
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("registry-owned MCP sibling 'github' is absent");
    expect(registration.config).toEqual(initialConfig);
    expect(registration.configText).not.toContain("openshell:resolve:env:GITHUB_TOKEN");
  });

  it("rejects a 65-server projection before rendering a mutation command", () => {
    const managedEntries = Array.from({ length: 65 }, (_, index): McpBridgeEntry => ({
      ...baseEntry,
      server: `server${String(index)}`,
      env: [`SERVER_${String(index)}_TOKEN`],
      providerName: `alpha-mcp-server-${String(index)}`,
      policyName: `mcp-bridge-server-${String(index)}`,
    }));

    expect(() =>
      buildDeepAgentsMcpRegisterCommand(managedEntries[0], false, managedEntries),
    ).toThrow(/at most 64 servers.*refusing to render a 65-server mutation/);
    expect(() =>
      buildDeepAgentsMcpRegisterCommand(managedEntries[0], false, managedEntries.slice(0, 64)),
    ).not.toThrow();
  });

  it("repairs and verifies every registry-owned server through the sandbox command boundary (#10756)", () => {
    const entries = [jiraEntry(), baseEntry];
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" });

    restoreDeepAgentsManagedMcpProjection("alpha", entries);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(5);
    const commands = executeSandboxCommandMock.mock.calls.map(([, command]) => command);
    expect(commands[1]).toBe("/usr/local/bin/deepagents-code --nemoclaw-mcp-capability");
    expect(commands[2]).toContain("github");
    expect(commands[2]).toContain("jira");
    expect(commands[3]).toContain("github");
    expect(commands[4]).toContain("jira");
    expect(commands.filter((command) => command.includes("allowRevisioned"))).toHaveLength(2);
  });

  it("resets the managed v2 projection when the registry has no Deep Agents bridges (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    restoreDeepAgentsManagedMcpProjection("alpha", []);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
    expect(executeSandboxCommandMock.mock.calls[2]?.[1]).toContain('\\"expectedServers\\":{}');
  });

  it("stops after runtime detection returns an unknown kind (#10756)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: "unknown\n",
      stderr: "",
    });

    expect(() => restoreDeepAgentsManagedMcpProjection("alpha", [])).toThrow(
      "Could not identify the managed Deep Agents MCP runtime.",
    );
    expect(executeSandboxCommandMock).toHaveBeenCalledOnce();
  });

  it("leaves the v2 projection unchanged for a legacy Deep Agents runtime (#10756)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: "legacy\n",
      stderr: "",
    });

    restoreDeepAgentsManagedMcpProjection("alpha", [baseEntry]);

    expect(executeSandboxCommandMock).toHaveBeenCalledOnce();
  });

  it("rejects a v2 runtime without the managed MCP mutation capability (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n",
        stderr: "",
      });

    expect(() => restoreDeepAgentsManagedMcpProjection("alpha", [baseEntry])).toThrow(
      "does not contain managed MCP capability v2",
    );
    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(2);
    expect(executeSandboxCommandMock.mock.calls[1]?.[1]).toBe(
      "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
    );
  });

  it("identifies a legacy runtime without changing either MCP config fixture (#10756)", () => {
    const managedConfig = { mcpServers: { managed: { url: "https://managed.invalid" } } };
    const legacyConfig = { mcpServers: { legacy: { url: "https://legacy.invalid" } } };

    const inspection = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRuntimeKindCommand(),
      managedConfig,
      "legacy",
      legacyConfig,
    );

    expect(inspection.status, inspection.stderr).toBe(0);
    expect(inspection.stdout.trim()).toBe("legacy");
    expect(inspection.config).toEqual(managedConfig);
    expect(inspection.legacyConfig).toEqual(legacyConfig);
  });

  it("fails when the managed projection mutation command fails (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "projection is unsafe" });

    expect(() => restoreDeepAgentsManagedMcpProjection("alpha", [baseEntry, jiraEntry()])).toThrow(
      "projection is unsafe",
    );
    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
  });

  it("fails when a repaired registry entry is not registered (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "mismatch\n", stderr: "" });

    expect(() => restoreDeepAgentsManagedMcpProjection("alpha", [baseEntry, jiraEntry()])).toThrow(
      "config verification failed after adding 'jira': mismatch",
    );
  });

  it.each([
    {
      label: "an adapter-less entry",
      entry: {
        server: baseEntry.server,
        agent: baseEntry.agent,
        url: baseEntry.url,
        env: baseEntry.env,
        providerName: baseEntry.providerName,
        policyName: baseEntry.policyName,
        addedAt: baseEntry.addedAt,
      },
    },
    {
      label: "another agent's entry",
      entry: { ...baseEntry, agent: "openclaw" },
    },
  ])("rejects $label before running a sandbox command (#10756)", ({ entry }) => {
    expect(() => restoreDeepAgentsManagedMcpProjection("alpha", [entry as McpBridgeEntry])).toThrow(
      "requires Deep Agents registry entries",
    );
    expect(executeSandboxCommandMock).not.toHaveBeenCalled();
  });
});
