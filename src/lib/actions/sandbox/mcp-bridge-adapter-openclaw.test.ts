// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
  buildOpenClawMcpRegisterCommand,
  buildOpenClawMcpRemoveCommand,
  buildStrictOpenClawMcpInspectCommand,
  MCPORTER_VERSION,
} from "./mcp-bridge-adapter-openclaw";
import { entryHeaders, openClawHeadersMatchExpected } from "./mcp-bridge-adapter-status";

const entry: McpSourceEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
};

function run(command: string) {
  return spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
}

describe("OpenClaw native MCP adapter", () => {
  it("atomically registers, inspects, and removes a native OpenClaw entry", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-"));
    const root = temp;
    const configPath = path.join(temp, "openclaw.json");
    try {
      fs.writeFileSync(configPath, JSON.stringify({ preserved: true }), { mode: 0o600 });
      expect(run(buildOpenClawMcpRegisterCommand(entry, false, root)).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        preserved: true,
        mcp: {
          servers: {
            github: {
              url: entry.url,
              headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
            },
          },
        },
      });
      const inspection = run(buildStrictOpenClawMcpInspectCommand(entry, true, root));
      expect(inspection.status).toBe(0);
      expect(inspection.stdout.trim()).toBe("registered");
      const revisioned = JSON.parse(fs.readFileSync(configPath, "utf8"));
      revisioned.mcp.servers.github.headers.Authorization =
        "Bearer openshell:resolve:env:v12_GITHUB_TOKEN";
      fs.writeFileSync(configPath, JSON.stringify(revisioned), { mode: 0o600 });
      expect(run(buildOpenClawMcpRemoveCommand(entry, false, root)).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        preserved: true,
        mcp: { servers: {} },
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("projects the exact OpenShell credential revision into native headers", () => {
    const command = buildOpenClawMcpRegisterCommand(entry, false, "/sandbox/.openclaw", "v12");
    expect(command).toContain("Bearer openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(openClawHeadersMatchExpected(
      { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
      entryHeaders(entry, "v12"),
    )).toBe(true);
  });

  it("refuses to remove a changed native entry unless force is explicit", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-drift-"));
    const root = temp;
    const configPath = path.join(temp, "openclaw.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcp: { servers: { github: { url: "https://changed.example/mcp" } } } }),
        { mode: 0o600 },
      );
      expect(run(buildOpenClawMcpRemoveCommand(entry, false, root)).status).toBe(2);
      expect(run(buildOpenClawMcpRemoveCommand(entry, true, root)).status).toBe(0);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps the legacy mcporter pin available only for migration", () => {
    expect(MCPORTER_VERSION).toBe("0.7.3");
  });
});
