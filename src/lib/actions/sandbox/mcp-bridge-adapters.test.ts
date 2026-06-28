// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
  buildOpenClawMcporterInspectCommand,
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  MCPORTER_VERSION,
  mcporterHeadersMatchExpected,
  parseAdapterRegistrationInspection,
  redactBridgeSecretsForDisplay,
} from "./mcp-bridge";

type McpBridgeEntry = Parameters<typeof buildOpenClawMcporterRegisterCommand>[0];

describe("MCP adapters", () => {
  const baseEntry: McpBridgeEntry = {
    server: "github",
    agent: "openclaw",
    adapter: "mcporter",
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

  it("constructs a mcporter HTTP registration with OpenShell env placeholders", () => {
    const command = buildOpenClawMcporterRegisterCommand(baseEntry);

    expect(command).toContain("'mcporter' 'config' 'add' 'github'");
    expect(command).toContain("'--url' 'https://api.githubcopilot.com/mcp/'");
    expect(command).toContain(
      "'--header' 'Authorization=Bearer openshell:resolve:env:GITHUB_TOKEN'",
    );
    expect(command).toContain("'--scope' 'home'");
    expect(command).toContain("already exists in mcporter config");
    expect(command).not.toContain("fake-secret");
  });

  it("accepts only mcporter's synthesized HTTP Accept header in ownership checks", () => {
    const expected = {
      Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
    };

    expect(
      mcporterHeadersMatchExpected(
        {
          ...expected,
          accept: "application/json, text/event-stream",
        },
        expected,
      ),
    ).toBe(true);
    expect(mcporterHeadersMatchExpected(expected, expected)).toBe(true);
    expect(
      mcporterHeadersMatchExpected(
        {
          ...expected,
          accept: "application/json",
        },
        expected,
      ),
    ).toBe(false);
    expect(
      mcporterHeadersMatchExpected(
        {
          ...expected,
          accept: "application/json, text/event-stream",
          "x-unowned": "drift",
        },
        expected,
      ),
    ).toBe(false);
    expect(
      mcporterHeadersMatchExpected(
        {
          Authorization: "Bearer changed",
          accept: "application/json, text/event-stream",
        },
        expected,
      ),
    ).toBe(false);
  });

  it("uses stdout ownership state even when the adapter emits a runtime warning", () => {
    expect(
      parseAdapterRegistrationInspection(
        {
          status: 0,
          stdout: "absent\n",
          stderr: "(node:1200) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
        },
        baseEntry,
      ),
    ).toEqual({ state: "absent" });
  });

  it("uses the normalized-header ownership rule in mcporter inspect and remove commands", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-owner-"));
    try {
      const fakeMcporter = path.join(temp, "mcporter");
      const removeMarker = path.join(temp, "removed");
      fs.writeFileSync(
        fakeMcporter,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const headers = JSON.parse(process.env.FAKE_MCPORTER_HEADERS || "{}");',
          'if (process.argv[3] === "get") {',
          "  process.stdout.write(JSON.stringify({",
          '    name: "github", transport: "http",',
          '    baseUrl: "https://api.githubcopilot.com/mcp/", headers,',
          "  }));",
          "  process.exit(0);",
          "}",
          'if (process.argv[3] === "remove") {',
          '  fs.writeFileSync(process.env.FAKE_MCPORTER_REMOVE_MARKER, "removed");',
          "  process.exit(0);",
          "}",
          "process.exit(3);",
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = (command: string, headers: Record<string, string>) =>
        spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH ?? ""}`,
            FAKE_MCPORTER_HEADERS: JSON.stringify(headers),
            FAKE_MCPORTER_REMOVE_MARKER: removeMarker,
          },
        });
      const normalizedHeaders = {
        Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
        accept: "application/json, text/event-stream",
      };

      const inspect = run(buildOpenClawMcporterInspectCommand(baseEntry, true), normalizedHeaders);
      expect(inspect.status).toBe(0);
      expect(inspect.stdout.trim()).toBe("registered");

      const remove = run(buildOpenClawMcporterRemoveCommand(baseEntry), normalizedHeaders);
      expect(remove.status).toBe(0);
      expect(fs.readFileSync(removeMarker, "utf8")).toBe("removed");

      fs.rmSync(removeMarker, { force: true });
      const drifted = run(buildOpenClawMcporterRemoveCommand(baseEntry), {
        ...normalizedHeaders,
        "x-unowned": "drift",
      });
      expect(drifted.status).toBe(2);
      expect(drifted.stderr).toContain("Refusing to remove modified mcporter MCP server");
      expect(fs.existsSync(removeMarker)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("constructs a Hermes config registration with placeholders", () => {
    const command = buildHermesMcpRegisterCommand({
      ...baseEntry,
      agent: "hermes",
      adapter: "hermes-config",
    });

    expect(command.slice(0, 3)).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "add",
      "--payload",
    ]);
    expect(JSON.parse(command[3] ?? "{}")).toEqual({
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
      replace_existing: false,
    });
    expect(buildHermesMcpExecArgs("hermes-box", command)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-box",
      "--timeout",
      "620",
      "--no-tty",
      "--",
      ...command,
    ]);
    expect(buildHermesMcpProbeCommand()).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "probe",
    ]);
    expect(buildHermesMcpExecArgs("hermes-box", buildHermesMcpProbeCommand(), 30)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-box",
      "--timeout",
      "30",
      "--no-tty",
      "--",
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "probe",
    ]);
  });

  it("constructs a Deep Agents .mcp.json registration with placeholders", () => {
    const command = buildDeepAgentsMcpRegisterCommand({
      ...baseEntry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
    });

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
    const registration = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand({
        ...baseEntry,
        agent: "langchain-deepagents-code",
        adapter: "deepagents-config",
      }),
    );

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

  it("does not fabricate Authorization headers for legacy entries without credentials", () => {
    const command = buildOpenClawMcporterRegisterCommand({
      ...baseEntry,
      env: [],
    });

    expect(command).not.toContain("Authorization=");
    expect(command).toContain("'--url' 'https://api.githubcopilot.com/mcp/'");
  });

  it("redacts credential values from adapter display output", () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "real-host-secret";
    try {
      const redacted = redactBridgeSecretsForDisplay(
        "failed header Authorization=Bearer real-host-secret raw real-host-secret",
        baseEntry,
      );

      expect(redacted).toBe("failed header Authorization=Bearer ***REDACTED*** raw ***REDACTED***");
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });

  it("redacts inline credential values that were not exported in host env", () => {
    const prior = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const redacted = redactBridgeSecretsForDisplay(
        "adapter echoed Authorization=Bearer inline-provider-secret and inline-provider-secret",
        baseEntry,
        { GITHUB_TOKEN: "inline-provider-secret" },
      );

      expect(redacted).toBe(
        "adapter echoed Authorization=Bearer ***REDACTED*** and ***REDACTED***",
      );
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });

  it("redacts resolved Authorization bearer values even without host env access", () => {
    const prior = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const redacted = redactBridgeSecretsForDisplay(
        '{"headers":{"Authorization":"Bearer resolved-provider-secret"},"raw":"Authorization: Bearer another-secret"}',
        baseEntry,
      );

      expect(redacted).not.toContain("resolved-provider-secret");
      expect(redacted).not.toContain("another-secret");
      expect(redacted).toContain("Bearer ***REDACTED***");
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });
});

describe("MCP image/runtime constants", () => {
  it("keeps the mcporter runtime pin visible for image tests", () => {
    expect(MCPORTER_VERSION).toBe("0.7.3");
  });
});
