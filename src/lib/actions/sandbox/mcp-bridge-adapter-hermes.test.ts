// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
} from "./mcp-bridge-adapter-hermes";
import { buildHermesMcpStatusCommand } from "./mcp-bridge-adapter-status";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("Hermes MCP config adapter", () => {
  it("constructs a Hermes config registration with placeholders", () => {
    const command = buildHermesMcpRegisterCommand(baseEntry);

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

  it("projects the readiness-proven credential revision without helper-only metadata (#10155)", () => {
    const command = buildHermesMcpRegisterCommand(baseEntry, false, "v12");

    expect(JSON.parse(command[3] ?? "{}")).toEqual({
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
      replace_existing: false,
    });
  });

  it("accepts a revision on resumed inspection and rejects a stale exact revision (#10155)", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-revision-"));
    const configPath = path.join(temp, "config.yaml");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcp_servers: {
          github: {
            url: baseEntry.url,
            enabled: true,
            timeout: 120,
            connect_timeout: 60,
            tools: { resources: true, prompts: true },
            headers: { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
          },
        },
      }),
    );

    const inspect = (credentialRevision?: "v11" | "v12") => {
      const command = buildHermesMcpStatusCommand(baseEntry, credentialRevision);
      const scriptStart = command.indexOf("\n") + 1;
      const scriptEnd = command.lastIndexOf("\nPY");
      expect(scriptStart, "Hermes status command Python start").toBeGreaterThan(0);
      expect(scriptEnd, "Hermes status command Python end").toBeGreaterThanOrEqual(scriptStart);
      const script = command
        .slice(scriptStart, scriptEnd)
        .replace("import json, pathlib, yaml", "import json, pathlib, sys, yaml")
        .replace(
          'config_path = pathlib.Path("/sandbox/.hermes/config.yaml")',
          "config_path = pathlib.Path(sys.argv[1])",
        );
      return spawnSync("python3", ["-", configPath], {
        encoding: "utf8",
        input: script,
        killSignal: "SIGKILL",
        timeout: 10_000,
      });
    };

    try {
      expect(inspect().stdout.trim()).toBe("registered");
      expect(inspect("v12").stdout.trim()).toBe("registered");
      expect(inspect("v11").stdout.trim()).toBe("mismatch");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
