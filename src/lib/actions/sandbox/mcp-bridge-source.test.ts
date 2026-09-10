// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  capturePolicy: vi.fn(),
  inspectProvider: vi.fn(),
  configRoot: "/sandbox",
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: (name: string) =>
    ({
      openclaw: {
        name: "openclaw",
        displayName: "OpenClaw",
        configPaths: { dir: "/sandbox/.openclaw" },
        mcpCapability: { support: "bridge", adapter: "openclaw-config" },
      },
      hermes: {
        name: "hermes",
        displayName: "Hermes",
        configPaths: { dir: `${mocks.configRoot}/.hermes` },
        mcpCapability: { support: "bridge", adapter: "hermes-config" },
      },
      "langchain-deepagents-code": {
        name: "langchain-deepagents-code",
        displayName: "Deep Agents Code",
        configPaths: { dir: `${mocks.configRoot}/.deepagents` },
        mcpCapability: { support: "bridge", adapter: "deepagents-config" },
      },
    })[name],
}));
vi.mock("../../policy", () => ({
  captureRecordedSandboxBasePolicy: mocks.capturePolicy,
}));
vi.mock("./mcp-bridge-provider-inspection", () => ({
  inspectMcpProvider: mocks.inspectProvider,
}));
vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
}));

import {
  inspectAgentMcpSources,
  inspectLegacyBridgeState,
  inspectPolicyOnlyMcpEntry,
  inspectSourceBridgeState,
} from "./mcp-bridge-source";

const sandbox = {
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
};
const runtimeSelection = { gatewayName: "nemoclaw", workspace: "default" };

describe("source-backed MCP inventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturePolicy.mockReturnValue(`version: 1
network_policies:
  mcp_bridge_github:
    name: mcp_bridge_github
    endpoints:
      - host: api.githubcopilot.com
        port: 443
        path: /mcp/
        protocol: mcp
        allowed_ips: ["8.8.8.8"]
        credential_binding:
          provider: alpha-mcp-github
        deny_rules:
          - method: tools/call
            tool: delete_*
`);
    mocks.inspectProvider.mockReturnValue({
      exists: true,
      id: "provider-id",
      resourceVersion: 4,
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    });
  });

  it.each([
    ["langchain-deepagents-code", ".deepagents", ".mcp.json", "mcpServers", "native"],
    ["langchain-deepagents-code", ".deepagents", ".nemoclaw-mcp.json", "mcpServers", "legacy"],
    ["hermes", ".hermes", "config.yaml", "mcp_servers", "native"],
  ])(
    "reads %s from literal paths without sandbox Python packages (%s/%s)",
    async (agent, directory, file, serverMap, source) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-source-"quoted"-'));
      mocks.configRoot = root;
      try {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(
          path.join(root, directory, file),
          JSON.stringify({
            [serverMap]: {
              github: {
                url: "https://api.githubcopilot.com/mcp/",
                headers: { Authorization: "Bearer openshell:resolve:env:v42_GITHUB_TOKEN" },
              },
            },
          }),
          { mode: 0o600 },
        );
        mocks.executeSandboxCommand.mockImplementation((_name: string, command: string) => {
          const program = command.split("<<'PY'\n")[1].split("\nPY")[0];
          const result = spawnSync("python3", ["-I", "-S", "-"], {
            cwd: root,
            input: program,
            encoding: "utf8",
            timeout: 10_000,
          });
          return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        });
        const observed = await inspectAgentMcpSources({ ...sandbox, agent }, runtimeSelection);
        expect(observed[source as "native" | "legacy"].github).toMatchObject({
          server: "github",
          agent,
          source,
          url: "https://api.githubcopilot.com/mcp/",
          env: ["GITHUB_TOKEN"],
        });
      } finally {
        mocks.configRoot = "/sandbox";
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("joins native agent configuration with live policy and provider state", async () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          server: "github",
          url: "https://api.githubcopilot.com/mcp/",
          env: "GITHUB_TOKEN",
          source: "native",
        },
      ]),
      stderr: "",
    });

    expect(
      (await inspectSourceBridgeState(sandbox, runtimeSelection)).bridges.github,
    ).toMatchObject({
      source: "native",
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      policyName: "mcp-bridge-github",
      providerName: "alpha-mcp-github",
      providerId: "provider-id",
      allowedIps: ["8.8.8.8"],
      denyTools: ["delete_*"],
    });
  });

  it("keeps legacy configuration separate for explicit migration", async () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          server: "github",
          url: "https://api.githubcopilot.com/mcp/",
          env: "GITHUB_TOKEN",
          source: "legacy",
        },
      ]),
      stderr: "",
    });

    const observed = await inspectLegacyBridgeState(sandbox, runtimeSelection);
    expect(observed.sources.native).toEqual({});
    expect(observed.bridges.github).toMatchObject({
      source: "legacy",
      providerName: "alpha-mcp-github",
    });
  });

  it("recovers the deterministic live provider when the policy route is missing", async () => {
    mocks.capturePolicy.mockReturnValue("network_policies: {}\n");
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          server: "github",
          url: "https://api.githubcopilot.com/mcp/",
          env: "GITHUB_TOKEN",
          source: "native",
        },
      ]),
      stderr: "",
    });

    expect(
      (await inspectSourceBridgeState(sandbox, runtimeSelection)).bridges.github,
    ).toMatchObject({
      providerName: "alpha-mcp-github",
      providerId: "provider-id",
      source: "native",
    });
  });

  it("detects the owning agent from native MCP state after local registry loss", async () => {
    const recovered = { ...sandbox, agent: null };
    mocks.executeSandboxCommand.mockImplementation((_name: string, command: string) => ({
      status: 0,
      stdout: command.includes("/sandbox/.hermes/config.yaml")
        ? "mcp_servers:\n  github:\n    url: https://api.githubcopilot.com/mcp/\n    headers:\n      Authorization: Bearer openshell:resolve:env:GITHUB_TOKEN\n"
        : "[]",
      stderr: "",
    }));

    const observed = await inspectSourceBridgeState(recovered, runtimeSelection);
    expect(recovered.agent).toBe("hermes");
    expect(observed.bridges.github).toMatchObject({
      agent: "hermes",
      adapter: "hermes-config",
      source: "native",
    });
    const commands = mocks.executeSandboxCommand.mock.calls.map(([, command]) => String(command));
    expect(commands.find((command) => command.includes("/sandbox/.hermes/config.yaml"))).toContain(
      "if [ ! -e '/sandbox/.hermes/config.yaml' ]",
    );
    expect(commands.find((command) => command.includes("/sandbox/.hermes/config.yaml"))).toContain(
      "/usr/bin/python3.13 -I -S",
    );
    expect(commands.find((command) => command.includes("openclaw.json"))).toContain(
      "before.uid !== 0 && before.uid !== process.getuid()",
    );
  });

  it("reports a policy/provider orphan without inventing an agent registration", async () => {
    await expect(
      inspectPolicyOnlyMcpEntry(sandbox, "github", "openclaw", "openclaw-config", runtimeSelection),
    ).resolves.toMatchObject({
      source: "policy",
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "provider-id",
    });
  });

  it("reports an agent URL that conflicts with the live policy endpoint", async () => {
    mocks.capturePolicy.mockReturnValue(`network_policies:
  mcp_bridge_github:
    endpoints:
      - host: other.example.com
        port: 443
        path: /mcp/
        protocol: mcp
`);
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          server: "github",
          url: "https://api.githubcopilot.com/mcp/",
          env: "GITHUB_TOKEN",
          source: "native",
        },
      ]),
      stderr: "",
    });

    expect(
      (await inspectSourceBridgeState(sandbox, runtimeSelection)).bridges.github.policyConflict,
    ).toContain("differs from live policy endpoint");
  });

  it("redacts credentials and strips terminal controls from source-read failures", async () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "Authorization: Bearer source-secret\u001b[31m\n\u0007forged",
    });

    await expect(inspectSourceBridgeState(sandbox, runtimeSelection)).rejects.toThrow(
      "Could not inspect OpenClaw MCP configuration: Authorization: Bearer <REDACTED>\nforged",
    );
  });
});
