// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { buildDeepAgentsMcpRegisterCommand } from "./mcp-bridge-adapter-deepagents";
import { restoreDeepAgentsNativeMcpConfig } from "./mcp-bridge-adapter-deepagents-registration";
import { buildDeepAgentsMcpRuntimeKindCommand } from "./mcp-bridge-adapter-status";
import { executeSandboxCommand } from "./process-recovery";

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: vi.fn(),
}));

const executeSandboxCommandMock = vi.mocked(executeSandboxCommand);
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

function jiraEntry(): McpSourceEntry {
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
  it("writes only the agent-native config with a credential placeholder", () => {
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
        resetNativeConfig: true,
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

  it("preserves unrelated native config while registering a server", () => {
    const initialConfig = { ui: { theme: "dark" } };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry),
      initialConfig,
    );

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.config).toEqual({
      ...initialConfig,
      mcpServers: {
        github: {
          type: "http",
          url: baseEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
      },
    });
  });

  it("replaces an unsafe symbolic link during snapshot restore without following it (#10756)", () => {
    const initialConfig = { mcpServers: {} };
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetNativeConfig: true,
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
        resetNativeConfig: true,
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
        resetNativeConfig: true,
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

  it("preserves a directory at the native config path for operator recovery (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], false, "v12", {
        resetNativeConfig: true,
      }),
      undefined,
      "v2",
      undefined,
      0o600,
      { directory: true },
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("native MCP configuration path is a directory");
    expect(registration.managedDirectoryEntries).toEqual(["preserved.txt"]);
  });

  it.each([
    { label: "symbolic link", managedOptions: { symlink: true } },
    { label: "FIFO", managedOptions: { fifo: true } },
  ])(
    "replaces an unsafe $label with an empty native config when the registry is empty (#10756)",
    ({ managedOptions }) => {
      const initialConfig = { mcpServers: { unmanaged: { command: "unmanaged" } } };
      const registration = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpRegisterCommand(undefined, true, [], false, undefined, {
          resetNativeConfig: true,
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

  it("preserves a directory when an empty handoff requires native reset (#10756)", () => {
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(undefined, true, [], false, undefined, {
        resetNativeConfig: true,
      }),
      undefined,
      "v2",
      undefined,
      0o600,
      { directory: true },
    );

    expect(registration.status).toBe(2);
    expect(registration.stderr).toContain("native MCP configuration path is a directory");
    expect(registration.managedDirectoryEntries).toEqual(["preserved.txt"]);
  });

  it("preserves a sibling revision while revising the target server", () => {
    const jiraEntry: McpSourceEntry = {
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

  it("does not reconstruct an absent sibling from command-local handoff state", () => {
    const jiraEntry: McpSourceEntry = {
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

    expect(registration.status, registration.stderr).toBe(0);
    expect(registration.config).toEqual({
      mcpServers: {
        jira: {
          type: "http",
          url: jiraEntry.url,
          headers: { Authorization: "Bearer openshell:resolve:env:v12_JIRA_MCP_TOKEN" },
        },
      },
    });
    expect(registration.configText).not.toContain("openshell:resolve:env:GITHUB_TOKEN");
  });

  it("rejects a 65-server config before rendering a mutation command", () => {
    const managedEntries = Array.from({ length: 65 }, (_, index): McpSourceEntry => ({
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
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" });

    restoreDeepAgentsNativeMcpConfig("alpha", entries, runtimeSelection);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(5);
    expect(
      executeSandboxCommandMock.mock.calls.every((call) => {
        const options = call[2];
        return typeof options === "object" && options?.runtimeSelection === runtimeSelection;
      }),
    ).toBe(true);
    const commands = executeSandboxCommandMock.mock.calls.map(([, command]) => command);
    expect(commands[1]).toBe("/usr/local/bin/deepagents-code --nemoclaw-mcp-capability");
    expect(commands[2]).toContain("github");
    expect(commands[2]).toContain("jira");
    expect(commands[3]).toContain("github");
    expect(commands[4]).toContain("jira");
    expect(commands.filter((command) => command.includes("allowRevisioned"))).toHaveLength(2);
    expect(executeSandboxCommandMock.mock.calls.map(([, , options]) => options)).toEqual(
      Array.from({ length: 5 }, () => ({ runtimeSelection })),
    );
  });

  it("resets the native MCP configuration when the registry has no Deep Agents bridges (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    restoreDeepAgentsNativeMcpConfig("alpha", [], runtimeSelection);

    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
    expect(executeSandboxCommandMock.mock.calls[2]?.[1]).toContain('\\"expectedServers\\":{}');
  });

  it("stops after runtime detection returns an unknown kind (#10756)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: "unknown\n",
      stderr: "",
    });

    expect(() => restoreDeepAgentsNativeMcpConfig("alpha", [], runtimeSelection)).toThrow(
      "Could not identify the managed Deep Agents MCP runtime.",
    );
    expect(executeSandboxCommandMock).toHaveBeenCalledOnce();
  });

  it("leaves the native config unchanged for a legacy Deep Agents runtime (#10756)", () => {
    executeSandboxCommandMock.mockReturnValueOnce({
      status: 0,
      stdout: "legacy\n",
      stderr: "",
    });

    restoreDeepAgentsNativeMcpConfig("alpha", [baseEntry], runtimeSelection);

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

    expect(() => restoreDeepAgentsNativeMcpConfig("alpha", [baseEntry], runtimeSelection)).toThrow(
      "does not contain native MCP capability v3",
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

  it("fails when the native config mutation command fails (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "native config is unsafe" });

    expect(() =>
      restoreDeepAgentsNativeMcpConfig("alpha", [baseEntry, jiraEntry()], runtimeSelection),
    ).toThrow("native config is unsafe");
    expect(executeSandboxCommandMock).toHaveBeenCalledTimes(3);
  });

  it("fails when a repaired registry entry is not registered (#10756)", () => {
    executeSandboxCommandMock
      .mockReturnValueOnce({ status: 0, stdout: "v2\n", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3\n",
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registered\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "mismatch\n", stderr: "" });

    expect(() =>
      restoreDeepAgentsNativeMcpConfig("alpha", [baseEntry, jiraEntry()], runtimeSelection),
    ).toThrow("config verification failed after adding 'jira': mismatch");
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
      },
    },
    {
      label: "another agent's entry",
      entry: { ...baseEntry, agent: "openclaw" },
    },
  ])("rejects $label before running a sandbox command (#10756)", ({ entry }) => {
    expect(() =>
      restoreDeepAgentsNativeMcpConfig("alpha", [entry as McpSourceEntry], runtimeSelection),
    ).toThrow("requires Deep Agents source entries");
    expect(executeSandboxCommandMock).not.toHaveBeenCalled();
  });
});
