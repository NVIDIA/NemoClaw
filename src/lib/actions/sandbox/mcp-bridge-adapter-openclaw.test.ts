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
  OPENCLAW_MCPORTER_ROOT,
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

  it("registers, inspects, and removes the OpenClaw workspace project config", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-owner-"));
    try {
      const fakeMcporter = path.join(temp, "mcporter");
      const configState = path.join(temp, "config.json");
      const argvLog = path.join(temp, "argv.jsonl");
      const removeMarker = path.join(temp, "removed");
      fs.writeFileSync(
        fakeMcporter,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.FAKE_MCPORTER_ARGV_LOG, `${JSON.stringify(args)}\\n`);",
          'const configIndex = args.indexOf("config");',
          "const subcommand = configIndex >= 0 ? args[configIndex + 1] : undefined;",
          'if (subcommand === "get") {',
          '  if (!fs.existsSync(process.env.FAKE_MCPORTER_CONFIG)) { console.error("not found"); process.exit(1); }',
          '  process.stdout.write(fs.readFileSync(process.env.FAKE_MCPORTER_CONFIG, "utf8"));',
          "  process.exit(0);",
          "}",
          'if (subcommand === "add") {',
          "  const value = (flag) => args[args.indexOf(flag) + 1];",
          '  const header = value("--header").split("=");',
          "  fs.writeFileSync(process.env.FAKE_MCPORTER_CONFIG, JSON.stringify({",
          '    name: args[configIndex + 2], transport: "http", baseUrl: value("--url"),',
          '    headers: { [header[0]]: header.slice(1).join("=") },',
          "  }));",
          "  process.exit(0);",
          "}",
          'if (subcommand === "remove") {',
          "  fs.rmSync(process.env.FAKE_MCPORTER_CONFIG, { force: true });",
          '  fs.writeFileSync(process.env.FAKE_MCPORTER_REMOVE_MARKER, "removed");',
          "  process.exit(0);",
          "}",
          "process.exit(3);",
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = (command: string) =>
        spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH ?? ""}`,
            FAKE_MCPORTER_ARGV_LOG: argvLog,
            FAKE_MCPORTER_CONFIG: configState,
            FAKE_MCPORTER_REMOVE_MARKER: removeMarker,
          },
        });
      const normalizedHeaders = {
        Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
        accept: "application/json, text/event-stream",
      };

      const register = run(buildOpenClawMcporterRegisterCommand(baseEntry));
      expect(register.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(configState, "utf8"))).toEqual({
        name: "github",
        transport: "http",
        baseUrl: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
        },
      });

      const inspect = run(buildOpenClawMcporterInspectCommand(baseEntry, true));
      expect(inspect.status).toBe(0);
      expect(inspect.stdout.trim()).toBe("registered");

      fs.writeFileSync(
        configState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: { ...normalizedHeaders, "x-unowned": "drift" },
        }),
      );
      const drifted = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(drifted.status).toBe(2);
      expect(drifted.stderr).toContain("Refusing to remove modified mcporter MCP server");
      expect(fs.existsSync(removeMarker)).toBe(false);

      fs.writeFileSync(
        configState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      const remove = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(remove.status).toBe(0);
      expect(fs.readFileSync(removeMarker, "utf8")).toBe("removed");
      expect(fs.existsSync(configState)).toBe(false);

      const observedArgs = fs
        .readFileSync(argvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "add",
        "github",
        "--url",
        "https://api.githubcopilot.com/mcp/",
        "--header",
        "Authorization=Bearer openshell:resolve:env:GITHUB_TOKEN",
        "--scope",
        "project",
      ]);
      expect(
        observedArgs.filter((args) => args[2] === "config" && args[3] === "get"),
      ).not.toHaveLength(0);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "remove",
        "github",
      ]);
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
