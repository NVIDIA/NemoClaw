// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  MCPORTER_VERSION,
  OPENCLAW_MCPORTER_ROOT,
} from "./mcp-bridge-adapter-openclaw";
import {
  entryHeaders,
  buildOpenClawMcporterInspectCommand,
  mcporterHeadersMatchExpected,
  openClawMcporterRoot,
} from "./mcp-bridge-adapter-status";

const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
  .filter(Boolean)
  .join(" ");

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

describe("OpenClaw mcporter MCP adapter", testTimeoutOptions(20_000), () => {
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
          Authorization: "Bearer openshell:resolve:env:v1442987827285932589_GITHUB_TOKEN",
          accept: "application/json, text/event-stream",
        },
        expected,
      ),
    ).toBe(true);
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
          Authorization: "Bearer openshell:resolve:env:v42_OTHER_TOKEN",
          accept: "application/json, text/event-stream",
        },
        expected,
      ),
    ).toBe(false);
    expect(
      mcporterHeadersMatchExpected(
        {
          Authorization: `Bearer openshell:resolve:env:v${"1".repeat(21)}_GITHUB_TOKEN`,
          accept: "application/json, text/event-stream",
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

  it.each([
    "Bearer openshell:resolve:env:v_GITHUB_TOKEN",
    "Bearer openshell:resolve:env:v42_OTHER_TOKEN",
    "Bearer openshell:resolve:env:v42x_GITHUB_TOKEN",
    `Bearer openshell:resolve:env:v${"1".repeat(21)}_GITHUB_TOKEN`,
  ])("rejects an unsafe revisioned mcporter Authorization header: %s", (authorization) => {
    expect(
      mcporterHeadersMatchExpected(
        { Authorization: authorization },
        { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
      ),
    ).toBe(false);
  });

  it("projects the live OpenShell credential revision into mcporter config", () => {
    const command = buildOpenClawMcporterRegisterCommand(
      baseEntry,
      false,
      OPENCLAW_MCPORTER_ROOT,
      "v1442987827285932589",
    );

    expect(command).toContain(
      "Authorization=Bearer openshell:resolve:env:v1442987827285932589_GITHUB_TOKEN",
    );
    expect(command).not.toContain("Authorization=Bearer openshell:resolve:env:GITHUB_TOKEN'");
  });

  it("matches the exact readiness-proven revision during post-write inspection", () => {
    const expectedV12 = entryHeaders(baseEntry, "v12");

    expect(
      mcporterHeadersMatchExpected(
        { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
        expectedV12,
      ),
    ).toBe(true);
    expect(
      mcporterHeadersMatchExpected(
        { Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN" },
        expectedV12,
      ),
    ).toBe(false);
  });

  it("registers, inspects, and removes the OpenClaw workspace project config", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-owner-"));
    try {
      const fakeMcporter = path.join(temp, "mcporter");
      const configState = path.join(temp, "config.json");
      const configJsoncState = `${configState}c`;
      const homeConfigState = path.join(temp, "xdg", "mcporter", "mcporter.json");
      const homeConfigJsoncState = `${homeConfigState}c`;
      const defaultXdgConfigState = path.join(temp, "home", ".config", "mcporter", "mcporter.json");
      const legacyConfigState = path.join(temp, "legacy", "mcporter.json");
      const legacyConfigJsoncState = `${legacyConfigState}c`;
      const argvLog = path.join(temp, "argv.jsonl");
      const removeMarker = path.join(temp, "removed");
      fs.writeFileSync(
        fakeMcporter,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "const args = process.argv.slice(2);",
          "fs.appendFileSync(process.env.FAKE_MCPORTER_ARGV_LOG, `${JSON.stringify(args)}\\n`);",
          'const configIndex = args.indexOf("config");',
          "let cursor = configIndex + 1;",
          "let requestedConfig;",
          'if (args[cursor] === "--config") { requestedConfig = args[cursor + 1]; cursor += 2; }',
          "const subcommand = configIndex >= 0 ? args[cursor] : undefined;",
          "const server = args[cursor + 1];",
          "const value = (flag) => args[args.indexOf(flag) + 1];",
          'const root = value("--root");',
          'const projectRoot = path.join(root, "config");',
          "const configPath = (requested) => {",
          "  if (!requested) {",
          "    if (fs.existsSync(process.env.FAKE_MCPORTER_PROJECT_CONFIG)) return process.env.FAKE_MCPORTER_PROJECT_CONFIG;",
          "    if (fs.existsSync(process.env.FAKE_MCPORTER_HOME_CONFIG)) return process.env.FAKE_MCPORTER_HOME_CONFIG;",
          "    return process.env.FAKE_MCPORTER_LEGACY_CONFIG;",
          "  }",
          '  if (requested.startsWith(projectRoot)) return requested.endsWith(".jsonc") ? `${process.env.FAKE_MCPORTER_PROJECT_CONFIG}c` : process.env.FAKE_MCPORTER_PROJECT_CONFIG;',
          "  if (requested.startsWith(path.dirname(process.env.FAKE_MCPORTER_HOME_CONFIG))) return requested;",
          '  return requested.endsWith(".jsonc") ? `${process.env.FAKE_MCPORTER_LEGACY_CONFIG}c` : process.env.FAKE_MCPORTER_LEGACY_CONFIG;',
          "};",
          "const selectedConfig = configPath(requestedConfig);",
          'if (subcommand === "get") {',
          "  if (!fs.existsSync(selectedConfig)) {",
          "    console.error(requestedConfig ? `ENOENT: no such file or directory, open '${requestedConfig}'` : \"not found\");",
          "    process.exit(1);",
          "  }",
          '  process.stdout.write(fs.readFileSync(selectedConfig, "utf8"));',
          "  process.exit(0);",
          "}",
          'if (subcommand === "add") {',
          '  const header = value("--header").split("=");',
          "  fs.writeFileSync(process.env.FAKE_MCPORTER_PROJECT_CONFIG, JSON.stringify({",
          '    name: server, transport: "http", baseUrl: value("--url"),',
          '    headers: { [header[0]]: header.slice(1).join("=") },',
          "  }));",
          "  process.exit(0);",
          "}",
          'if (subcommand === "remove") {',
          "  fs.rmSync(selectedConfig, { force: true });",
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
            XDG_CONFIG_HOME: path.join(temp, "xdg"),
            FAKE_MCPORTER_ARGV_LOG: argvLog,
            FAKE_MCPORTER_PROJECT_CONFIG: configState,
            FAKE_MCPORTER_HOME_CONFIG: homeConfigState,
            FAKE_MCPORTER_LEGACY_CONFIG: legacyConfigState,
            FAKE_MCPORTER_REMOVE_MARKER: removeMarker,
          },
        });
      const runWithoutXdg = (command: string) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: path.join(temp, "home"),
          PATH: `${temp}:${process.env.PATH ?? ""}`,
          FAKE_MCPORTER_ARGV_LOG: argvLog,
          FAKE_MCPORTER_PROJECT_CONFIG: configState,
          FAKE_MCPORTER_HOME_CONFIG: defaultXdgConfigState,
          FAKE_MCPORTER_LEGACY_CONFIG: legacyConfigState,
          FAKE_MCPORTER_REMOVE_MARKER: removeMarker,
        };
        delete env.XDG_CONFIG_HOME;
        return spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env,
        });
      };
      const normalizedHeaders = {
        Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN",
        accept: "application/json, text/event-stream",
      };
      const expectFileAbsent = (filePath: string) =>
        expect(fs.readdirSync(path.dirname(filePath))).not.toContain(path.basename(filePath));
      const expectFilePresent = (filePath: string) =>
        expect(fs.readFileSync(filePath, "utf8")).not.toBe("");

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
      expectFileAbsent(removeMarker);

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
      expectFileAbsent(configState);

      fs.mkdirSync(path.dirname(homeConfigState), { recursive: true });
      fs.writeFileSync(
        homeConfigState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      fs.mkdirSync(path.dirname(legacyConfigState), { recursive: true });
      fs.writeFileSync(
        legacyConfigState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      expect(run(buildOpenClawMcporterRegisterCommand(baseEntry, true)).status).toBe(0);
      expectFilePresent(configState);
      expectFilePresent(homeConfigState);
      expectFilePresent(legacyConfigState);

      const layeredRemove = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(layeredRemove.status).toBe(0);
      expectFileAbsent(configState);
      expectFileAbsent(homeConfigState);
      expectFileAbsent(legacyConfigState);
      expect(run(buildOpenClawMcporterInspectCommand(baseEntry, false)).stdout.trim()).toBe(
        "absent",
      );

      [configJsoncState, homeConfigJsoncState, legacyConfigJsoncState].forEach((jsoncState) => {
        fs.mkdirSync(path.dirname(jsoncState), { recursive: true });
        fs.writeFileSync(
          jsoncState,
          JSON.stringify({
            name: "github",
            transport: "http",
            baseUrl: "https://api.githubcopilot.com/mcp/",
            headers: normalizedHeaders,
          }),
        );
      });
      const layeredJsoncRemove = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(layeredJsoncRemove.status).toBe(0);
      expectFileAbsent(configJsoncState);
      expectFileAbsent(homeConfigJsoncState);
      expectFileAbsent(legacyConfigJsoncState);

      fs.writeFileSync(
        configState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      fs.writeFileSync(
        homeConfigJsoncState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://user.example.test/mcp",
          headers: normalizedHeaders,
        }),
      );
      const driftedJsonc = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(driftedJsonc.status).toBe(2);
      expectFilePresent(configState);
      expectFilePresent(homeConfigJsoncState);
      fs.rmSync(configState);
      fs.rmSync(homeConfigJsoncState);

      fs.mkdirSync(path.dirname(defaultXdgConfigState), { recursive: true });
      fs.writeFileSync(
        defaultXdgConfigState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      expect(runWithoutXdg(buildOpenClawMcporterRegisterCommand(baseEntry, true)).status).toBe(0);
      const defaultXdgRemove = runWithoutXdg(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(defaultXdgRemove.status).toBe(0);
      expectFileAbsent(configState);
      expectFileAbsent(defaultXdgConfigState);
      const defaultXdgInspect = runWithoutXdg(
        buildOpenClawMcporterInspectCommand(baseEntry, false),
      );
      expect(defaultXdgInspect.status).toBe(0);
      expect(defaultXdgInspect.stdout.trim()).toBe("absent");

      fs.writeFileSync(
        configState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://api.githubcopilot.com/mcp/",
          headers: normalizedHeaders,
        }),
      );
      fs.writeFileSync(
        homeConfigState,
        JSON.stringify({
          name: "github",
          transport: "http",
          baseUrl: "https://user.example.test/mcp",
          headers: normalizedHeaders,
        }),
      );
      const driftedHome = run(buildOpenClawMcporterRemoveCommand(baseEntry));
      expect(driftedHome.status).toBe(2);
      expectFilePresent(configState);
      expectFilePresent(homeConfigState);

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
      const configGets = observedArgs.filter(
        (args) => args.includes("config") && args.includes("get"),
      );
      expect(configGets).not.toHaveLength(0);
      configGets.forEach((args) => {
        expect(args.slice(0, 3)).toEqual(["--root", OPENCLAW_MCPORTER_ROOT, "config"]);
        expect(args.at(-1)).toBe("--json");
      });
      expect(configGets).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "get",
        "github",
        "--json",
      ]);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "--config",
        `${OPENCLAW_MCPORTER_ROOT}/config/mcporter.json`,
        "remove",
        "github",
      ]);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "--config",
        `${OPENCLAW_MCPORTER_ROOT}/config/mcporter.jsonc`,
        "remove",
        "github",
      ]);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "--config",
        path.join(os.homedir(), ".mcporter", "mcporter.json"),
        "remove",
        "github",
      ]);
      expect(observedArgs).toContainEqual([
        "--root",
        OPENCLAW_MCPORTER_ROOT,
        "config",
        "--config",
        homeConfigState,
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

  it("targets a custom OpenClaw workspace for every mcporter lifecycle command", () => {
    const root = openClawMcporterRoot("/sandbox/.custom-openclaw/");
    const commands = [
      buildOpenClawMcporterRegisterCommand(baseEntry, false, root),
      buildOpenClawMcporterInspectCommand(baseEntry, true, root),
      buildOpenClawMcporterRemoveCommand(baseEntry, false, root),
    ];

    expect(root).toBe("/sandbox/.custom-openclaw/workspace");
    commands.forEach((command) => {
      expect(command).toContain(root);
      expect(command).not.toContain(OPENCLAW_MCPORTER_ROOT);
    });
  });

  it("uses the loaded OpenClaw workspace throughout adapter lifecycle calls", () => {
    const script = `
const agentDefs = require("./src/lib/agent/defs.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
agentDefs.loadAgent = () => ({
  name: "openclaw",
  displayName: "OpenClaw",
  configPaths: { dir: "/sandbox/.custom-openclaw" },
  mcpCapability: { support: "bridge", adapter: "mcporter" },
});
const commands = [];
processRecovery.executeSandboxCommand = (_sandboxName, command) => {
  commands.push(command);
  return command === "command -v mcporter"
    ? { status: 0, stdout: "/usr/bin/mcporter\\n", stderr: "" }
    : { status: 0, stdout: command.includes("config get") ? "registered\\n" : "", stderr: "" };
};
const adapter = require("./src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.js");
const entry = ${JSON.stringify(baseEntry)};
adapter.registerOpenClawAdapter("custom-root-lifecycle", entry);
adapter.unregisterOpenClawAdapter("custom-root-lifecycle", entry);
process.stdout.write(JSON.stringify(commands));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const commands = JSON.parse(result.stdout) as string[];
    expect(commands).toHaveLength(4);
    commands.slice(1).forEach((command) => {
      expect(command).toContain("/sandbox/.custom-openclaw/workspace");
      expect(command).not.toContain(OPENCLAW_MCPORTER_ROOT);
    });
  });

  it("keeps the mcporter runtime pin visible for image tests", () => {
    expect(MCPORTER_VERSION).toBe("0.7.3");
  });
});
