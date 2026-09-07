// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDeepAgentsConfigCommand } from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import * as f from "./snapshot-restore-test-fixture";

const tempHomes: string[] = [];
const adapterMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  assertCapability: vi.fn(),
  inspectRegistration: vi.fn(),
}));

vi.mock("./mcp-bridge-adapter-deepagents-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-adapter-deepagents-command")>()),
  runDeepAgentsAdapterCommand: adapterMocks.runCommand,
}));

vi.mock("./mcp-bridge-adapter-deepagents-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-adapter-deepagents-capability")>()),
  assertDeepAgentsMcpMutationRuntimeCapability: adapterMocks.assertCapability,
}));

vi.mock("./mcp-bridge-adapter-deepagents-inspection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-adapter-deepagents-inspection")>()),
  inspectDeepAgentsAdapterRegistration: adapterMocks.inspectRegistration,
}));

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
  adapterMocks.runCommand.mockReset();
  adapterMocks.assertCapability.mockReset();
  adapterMocks.inspectRegistration.mockReset();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-handoff-home-"));
  tempHomes.push(tempHome);
  vi.stubEnv("HOME", tempHome);
});

afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  vi.unstubAllEnvs();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

describe("runSandboxSnapshot Deep Agents native config handoff", () => {
  it("executes the native config repair before restoring snapshot files (#10756)", async () => {
    f.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      name: "stable",
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    });
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      mcp: {
        bridges: {
          github: {
            server: "github",
            agent: "langchain-deepagents-code",
            adapter: "deepagents-config",
            url: "https://api.githubcopilot.com/mcp/",
            env: ["GITHUB_TOKEN"],
            providerName: "alpha-mcp-github",
            policyName: "mcp-bridge-github",
          },
          jira: {
            server: "jira",
            agent: "langchain-deepagents-code",
            adapter: "deepagents-config",
            url: "https://mcp.atlassian.com/v1/",
            env: ["JIRA_MCP_TOKEN"],
            providerName: "alpha-mcp-jira",
            policyName: "mcp-bridge-jira",
          },
          slack: {
            server: "slack",
            agent: "openclaw",
            adapter: "openclaw-config",
            url: "https://mcp.slack.com/v1/",
            env: ["SLACK_MCP_TOKEN"],
            providerName: "alpha-mcp-slack",
            policyName: "mcp-bridge-slack",
          },
        },
      },
    });

    let projectedConfig: ReturnType<typeof runDeepAgentsConfigCommand> | undefined;
    adapterMocks.runCommand
      .mockImplementationOnce((_sandboxName, _entry, command: string) => {
        expect(command).toContain("NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR");
        f.lifecycleMock.events.push("classify-runtime");
        return "v2\n";
      })
      .mockImplementationOnce((_sandboxName, _entry, command: string) => {
        expect(command).toContain("reset_native_config(data)");
        f.lifecycleMock.events.push("restore-mcp-native-config");
        projectedConfig = runDeepAgentsConfigCommand(command);
        expect(projectedConfig.status, projectedConfig.stderr).toBe(0);
        return projectedConfig.stdout;
      });
    adapterMocks.assertCapability.mockImplementation(() => {
      f.lifecycleMock.events.push("authorize-mutation");
    });
    adapterMocks.inspectRegistration.mockImplementation(() => {
      f.lifecycleMock.events.push("verify-mcp-native-config");
      return { state: "registered" };
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      f.lifecycleMock.events.push("restore-snapshot-state");
      return {
        success: true,
        restoredDirs: [".state"],
        restoredFiles: ["config.toml"],
        failedDirs: [],
        failedFiles: [],
      };
    });

    vi.doUnmock("./mcp-bridge-adapter-deepagents-registration");
    vi.resetModules();
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(projectedConfig?.status, projectedConfig?.stderr).toBe(0);
    expect(projectedConfig?.config).toEqual({
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
        jira: {
          type: "http",
          url: "https://mcp.atlassian.com/v1/",
          headers: { Authorization: "Bearer openshell:resolve:env:JIRA_MCP_TOKEN" },
        },
      },
    });
    expect(projectedConfig?.configText).not.toContain("SLACK_MCP_TOKEN");
    expect(f.lifecycleMock.events).toEqual([
      "classify-runtime",
      "authorize-mutation",
      "restore-mcp-native-config",
      "verify-mcp-native-config",
      "verify-mcp-native-config",
      "restore-snapshot-state",
    ]);
  });
});
