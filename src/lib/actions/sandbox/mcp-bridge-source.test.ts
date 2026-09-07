// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  capturePolicy: vi.fn(),
  inspectProvider: vi.fn(),
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
        configPaths: { dir: "/sandbox/.hermes" },
        mcpCapability: { support: "bridge", adapter: "hermes-config" },
      },
      "langchain-deepagents-code": {
        name: "langchain-deepagents-code",
        displayName: "Deep Agents Code",
        configPaths: { dir: "/sandbox/.deepagents" },
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
`);
    mocks.inspectProvider.mockReturnValue({
      exists: true,
      id: "provider-id",
      resourceVersion: 4,
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    });
  });

  it("joins native agent configuration with live policy and provider state", () => {
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

    expect(inspectSourceBridgeState(sandbox, runtimeSelection).bridges.github).toMatchObject({
      source: "native",
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      policyName: "mcp-bridge-github",
      providerName: "alpha-mcp-github",
      providerId: "provider-id",
      allowedIps: ["8.8.8.8"],
    });
  });

  it("keeps legacy configuration separate for explicit migration", () => {
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

    const observed = inspectLegacyBridgeState(sandbox, runtimeSelection);
    expect(observed.sources.native).toEqual({});
    expect(observed.bridges.github).toMatchObject({
      source: "legacy",
      providerName: "alpha-mcp-github",
    });
  });

  it("detects the owning agent from native MCP state after local registry loss", () => {
    const recovered = { ...sandbox, agent: null };
    mocks.executeSandboxCommand.mockImplementation((_name: string, command: string) => ({
      status: 0,
      stdout: command.includes("/sandbox/.hermes/config.yaml")
        ? JSON.stringify([
            {
              server: "github",
              url: "https://api.githubcopilot.com/mcp/",
              env: "GITHUB_TOKEN",
              source: "native",
            },
          ])
        : "[]",
      stderr: "",
    }));

    const observed = inspectSourceBridgeState(recovered, runtimeSelection);
    expect(recovered.agent).toBe("hermes");
    expect(observed.bridges.github).toMatchObject({
      agent: "hermes",
      adapter: "hermes-config",
      source: "native",
    });
  });

  it("reports a policy/provider orphan without inventing an agent registration", () => {
    expect(
      inspectPolicyOnlyMcpEntry(sandbox, "github", "openclaw", "openclaw-config", runtimeSelection),
    ).toMatchObject({
      source: "policy",
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "provider-id",
    });
  });

  it("reports an agent URL that conflicts with the live policy endpoint", () => {
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
      inspectSourceBridgeState(sandbox, runtimeSelection).bridges.github.policyConflict,
    ).toContain("differs from live policy endpoint");
  });
});
