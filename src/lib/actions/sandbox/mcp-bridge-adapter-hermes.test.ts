// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
} from "./mcp-bridge-adapter-hermes";
import {
  buildHermesMcpStatusCommand,
  hermesManagedServerConfig,
} from "./mcp-bridge-adapter-status";

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

  it("matches only the exact current revisioned runtime placeholder", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-status-"));
    const configPath = path.join(tempDir, "config.yaml");
    const runStatus = (authorization: string, runtimePlaceholder: string) => {
      fs.writeFileSync(
        configPath,
        YAML.stringify({
          mcp_servers: {
            github: {
              ...hermesManagedServerConfig(baseEntry),
              headers: { Authorization: authorization },
            },
          },
        }),
      );
      const command = buildHermesMcpStatusCommand(baseEntry)
        .replace("/opt/hermes/.venv/bin/python", "python3")
        .replace("/sandbox/.hermes/config.yaml", configPath);
      return spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_TOKEN: runtimePlaceholder },
      });
    };

    try {
      const staleRevision = runStatus(
        "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
        "openshell:resolve:env:v12_GITHUB_TOKEN",
      );
      expect(staleRevision.status, staleRevision.stderr).toBe(0);
      expect(staleRevision.stdout.trim()).toBe("mismatch");

      const currentRevision = runStatus(
        "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
        "openshell:resolve:env:v12_GITHUB_TOKEN",
      );
      expect(currentRevision.status, currentRevision.stderr).toBe(0);
      expect(currentRevision.stdout.trim()).toBe("registered");

      const canonical = runStatus(
        "Bearer openshell:resolve:env:GITHUB_TOKEN",
        "openshell:resolve:env:v12_GITHUB_TOKEN",
      );
      expect(canonical.status, canonical.stderr).toBe(0);
      expect(canonical.stdout.trim()).toBe("mismatch");

      const rawRuntime = runStatus(
        "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
        "raw-secret",
      );
      expect(rawRuntime.status).toBe(3);
      expect(rawRuntime.stdout.trim()).toBe("error");
      expect(rawRuntime.stderr).not.toContain("raw-secret");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
