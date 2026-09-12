// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
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
  it("inspects a native OpenClaw entry without changing its configuration", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-"));
    const configPath = path.join(temp, "openclaw.json");
    const content = JSON.stringify({
      preserved: true,
      mcp: {
        servers: {
          github: {
            transport: "streamable-http",
            url: entry.url,
            headers: entryHeaders(entry),
          },
        },
      },
    });
    try {
      fs.writeFileSync(configPath, content, { mode: 0o600 });
      const inspection = run(buildStrictOpenClawMcpInspectCommand(entry, true, temp));
      expect(inspection.status).toBe(0);
      expect(inspection.stdout.trim()).toBe("registered");
      expect(fs.readFileSync(configPath, "utf8")).toBe(content);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("projects the exact OpenShell credential revision into native headers", () => {
    const command = buildStrictOpenClawMcpInspectCommand(entry, true, "/sandbox/.openclaw", "v12");
    expect(command).toContain('\\"transport\\":\\"streamable-http\\"');
    expect(command).toContain("Bearer openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(
      openClawHeadersMatchExpected(
        { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
        entryHeaders(entry, "v12"),
      ),
    ).toBe(true);
  });

  it("rejects a URL-only entry that OpenClaw would otherwise treat as legacy SSE", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-transport-"));
    const configPath = path.join(temp, "openclaw.json");
    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            servers: {
              github: {
                url: entry.url,
                headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
              },
            },
          },
        }),
        { mode: 0o600 },
      );

      const inspection = run(buildStrictOpenClawMcpInspectCommand(entry, true, temp));
      expect(inspection.status).toBe(2);
      expect(inspection.stdout.trim()).toBe("mismatch");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps the legacy mcporter pin available only for migration", () => {
    expect(MCPORTER_VERSION).toBe("0.7.3");
  });
});
