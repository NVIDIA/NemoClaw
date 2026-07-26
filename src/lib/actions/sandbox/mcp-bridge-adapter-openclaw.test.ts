// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  MCPORTER_VERSION,
} from "./mcp-bridge-adapter-openclaw";
import {
  buildOpenClawMcporterInspectCommand,
  mcporterHeadersMatchExpected,
} from "./mcp-bridge-adapter-status";

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

describe("OpenClaw mcporter MCP adapter", () => {
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

  it("does not fabricate Authorization headers for legacy entries without credentials", () => {
    const command = buildOpenClawMcporterRegisterCommand({
      ...baseEntry,
      env: [],
    });

    expect(command).not.toContain("Authorization=");
    expect(command).toContain("'--url' 'https://api.githubcopilot.com/mcp/'");
  });

  it("keeps the mcporter runtime pin visible for image tests", () => {
    expect(MCPORTER_VERSION).toBe("0.7.3");
  });
});
