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
  removeLegacyAgentMcpEntry,
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
    mocks.configRoot = "/sandbox";
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
    {
      agent: "langchain-deepagents-code",
      directory: ".deepagents",
      serverMap: "mcpServers",
      file: ".mcp.json",
      source: "native",
      usesYaml: false,
    },
    {
      agent: "langchain-deepagents-code",
      directory: ".deepagents",
      serverMap: "mcpServers",
      file: ".nemoclaw-mcp.json",
      source: "legacy",
      usesYaml: false,
    },
    {
      agent: "hermes",
      directory: ".hermes",
      serverMap: "mcp_servers",
      file: "config.yaml",
      source: "native",
      usesYaml: true,
    },
  ])(
    "reads $agent $source MCP sources from literal filesystem paths",
    ({ agent, directory, serverMap, file, source, usesYaml }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemoclaw-mcp-source-"quoted"-'));
      mocks.configRoot = root;
      try {
        const configDir = path.join(root, directory);
        fs.mkdirSync(configDir);
        fs.writeFileSync(
          path.join(configDir, file),
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
          const program = command.split("<<'PY'\n")[1]?.split("\nPY")[0] ?? "";
          const result = spawnSync("python3", ["-I", "-S", "-"], {
            cwd: root,
            input: program,
            encoding: "utf8",
            timeout: 10_000,
          });
          return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        });

        const observed = inspectAgentMcpSources({ ...sandbox, agent }, runtimeSelection);
        expect(observed).toEqual({
          native: {},
          legacy: {},
          [source]: {
            github: {
              server: "github",
              agent,
              adapter: usesYaml ? "hermes-config" : "deepagents-config",
              url: "https://api.githubcopilot.com/mcp/",
              env: ["GITHUB_TOKEN"],
              policyName: "mcp-bridge-github",
              source,
            },
          },
        });
      } finally {
        mocks.configRoot = "/sandbox";
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("reads historical Hermes YAML with no MCP configuration", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: "_config_version: 12\nplatforms:\n  discord:\n    enabled: true\n",
      stderr: "",
    });

    expect(inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection)).toEqual({
      native: {},
      legacy: {},
    });
  });

  it("removes the exact DeepAgents legacy key while preserving unrelated and native configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemoclaw-mcp-cleanup-"quoted"-'));
    mocks.configRoot = root;
    try {
      const directory = path.join(root, ".deepagents");
      fs.mkdirSync(directory);
      const legacyPath = path.join(directory, ".nemoclaw-mcp.json");
      const nativePath = path.join(directory, ".mcp.json");
      const retained = { command: "fixture-command", args: ["preserve"] };
      const nativeText = '{"mcpServers":{"native_server":{"url":"https://native.example/mcp"}}}\n';
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          mcpServers: {
            "github_tools-1": { url: "https://api.githubcopilot.com/mcp/" },
            unrelated_server: retained,
          },
          unrelated: { preserved: true },
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(nativePath, nativeText, { mode: 0o600 });
      mocks.executeSandboxCommand.mockImplementation((_name: string, command: string) => {
        const program = command.split("<<'PY'\n")[1]?.split("\nPY")[0] ?? "";
        const result = spawnSync("python3", ["-I", "-S", "-"], {
          cwd: root,
          input: program,
          encoding: "utf8",
          timeout: 10_000,
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      });

      removeLegacyAgentMcpEntry(
        { ...sandbox, agent: "langchain-deepagents-code" },
        {
          server: "github_tools-1",
          agent: "langchain-deepagents-code",
          adapter: "deepagents-config",
          url: "https://api.githubcopilot.com/mcp/",
          env: [],
          policyName: "mcp-bridge-github-tools-1",
          source: "legacy",
        },
        runtimeSelection,
      );

      expect(JSON.parse(fs.readFileSync(legacyPath, "utf8"))).toEqual({
        mcpServers: { unrelated_server: retained },
        unrelated: { preserved: true },
      });
      expect(fs.readFileSync(nativePath, "utf8")).toBe(nativeText);
      expect(fs.statSync(legacyPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(directory).sort()).toEqual([".mcp.json", ".nemoclaw-mcp.json"]);
    } finally {
      mocks.configRoot = "/sandbox";
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads Hermes MCP URL and credential references from YAML merge defaults", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: `defaults: &defaults
  url: https://api.githubcopilot.com/mcp/
  headers:
    Authorization: Bearer openshell:resolve:env:v42_GITHUB_TOKEN
mcp_servers:
  github:
    <<: *defaults
`,
      stderr: "",
    });

    expect(
      inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection).native.github,
    ).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
      source: "native",
    });
  });

  it("rejects unresolved Hermes YAML tags without exposing their contents", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: `mcp_servers:
  github: !unresolved-tag-secret
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer openshell:resolve:env:GITHUB_TOKEN
`,
      stderr: "",
    });

    expect(() => inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection)).toThrow(
      /^Hermes MCP source inspection returned invalid YAML\.$/,
    );
    expect(warning).not.toHaveBeenCalled();
  });

  it("preserves Hermes YAML key types before projecting server and header names", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: `mcp_servers:
  false:
    url: https://boolean.example.com/mcp/
  null:
    url: https://null.example.com/mcp/
  42:
    url: https://number.example.com/mcp/
  "true":
    url: https://api.githubcopilot.com/mcp/
    headers:
      false: ignored-boolean-header
      null: ignored-null-header
      42: ignored-number-header
      Authorization: Bearer openshell:resolve:env:v42_GITHUB_TOKEN
`,
      stderr: "",
    });

    const observed = inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection);
    expect(Object.keys(observed.native)).toEqual(["true"]);
    expect(observed.native.true).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      env: ["GITHUB_TOKEN"],
    });
  });

  it.each([
    ["Bearer openshell:resolve:env:GITHUB_TOKEN", ["GITHUB_TOKEN"]],
    ["Bearer openshell:resolve:env:v42_GITHUB_TOKEN", ["GITHUB_TOKEN"]],
    ["Bearer openshell:resolve:env:v123_lowercase_key", ["lowercase_key"]],
    ["Bearer openshell:resolve:env:_TOKEN", ["_TOKEN"]],
    ["Bearer openshell:resolve:env:4TOKEN", []],
    ["bearer openshell:resolve:env:GITHUB_TOKEN", []],
    ["Bearer not-a-reference-secret", []],
  ])("projects only Hermes credential references from %s", (authorization, env) => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        mcp_servers: {
          github: {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { aUtHoRiZaTiOn: authorization },
          },
        },
      }),
      stderr: "",
    });

    const observed = inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection);
    expect(observed.native.github.env).toEqual(env);
    expect(JSON.stringify(observed)).not.toContain("not-a-reference-secret");
  });

  it("rejects malformed Hermes YAML without exposing configuration contents", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: "mcp_servers: {github: [\nprivate_token: malformed-yaml-secret\n",
      stderr: "",
    });

    expect(() => inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection)).toThrow(
      /^Hermes MCP source inspection returned invalid YAML\.$/,
    );
    expect(warning).not.toHaveBeenCalled();
  });

  it("rejects oversized Hermes output before attempting YAML parsing", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: `mcp_servers: [${"oversized-secret".repeat(20_000)}`,
      stderr: "",
    });

    expect(() => inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection)).toThrow(
      /^Agent MCP source inspection returned oversized output\.$/,
    );
  });

  it("bounds Hermes source records before dropping invalid server entries", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        mcp_servers: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [String(index), { url: "invalid" }]),
        ),
      }),
      stderr: "",
    });

    expect(() => inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection)).toThrow(
      /^Agent MCP source inspection returned an invalid server collection\.$/,
    );
  });

  it("does not count unsupported Hermes entries toward the remote server limit", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        mcp_servers: {
          ...Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
              `stdio${index}`,
              { command: "local-mcp-server" },
            ]),
          ),
          missing: null,
          nonrecord: "local-mcp-server",
          invalid: { url: 42 },
          github: {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
          },
        },
      }),
      stderr: "",
    });

    const observed = inspectAgentMcpSources({ ...sandbox, agent: "hermes" }, runtimeSelection);
    expect(Object.keys(observed.native)).toEqual(["github"]);
    expect(observed.native.github.env).toEqual(["GITHUB_TOKEN"]);
  });

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
        ? JSON.stringify({
            mcp_servers: {
              github: {
                url: "https://api.githubcopilot.com/mcp/",
                headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
              },
            },
          })
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
