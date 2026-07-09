// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { restoreEnvBulk } from "../../../test/helpers/env-test-helpers.js";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";

const OPENCLAW_DIR = "/sandbox/.openclaw";

function imageInstall(id: string, extensionDir: string): OpenClawImagePluginInstall {
  const installPath = `${OPENCLAW_DIR}/extensions/${extensionDir}`;
  return { id, installPath, loadPaths: [installPath] };
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function extensionDir(install: OpenClawImagePluginInstall): string | null {
  const prefix = `${OPENCLAW_DIR}/extensions/`;
  return install.installPath.startsWith(prefix) ? install.installPath.slice(prefix.length) : null;
}

function runRestoreScenario(options: {
  backupConfig: Record<string, unknown>;
  backupExtensionDirs: string[];
  freshConfig: Record<string, unknown>;
  freshPluginInstalls: OpenClawImagePluginInstall[];
  previousPluginInstalls?: OpenClawImagePluginInstall[];
}): {
  cleanupCommand: string | undefined;
  freshMarkers: Record<string, string>;
  restore: ReturnType<typeof restoreRecreatedSandboxState>;
  restoredConfig: Record<string, any>;
  staleUserExtensionExists: boolean;
  userExtensionMarker: string;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recreated-restore-"));
  const previousOpenshellBin = process.env.NEMOCLAW_OPENSHELL_BIN;
  const previousPath = process.env.PATH;
  try {
    const binDir = path.join(fixture, "bin");
    const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
    const extensionsDir = path.join(openclawDir, "extensions");
    const backupPath = path.join(fixture, "backup");
    const backupExtensionsDir = path.join(backupPath, "extensions");
    const sshLog = path.join(fixture, "ssh-log.jsonl");
    const freshExtensionDirs = [
      "nemoclaw",
      ...options.freshPluginInstalls
        .map(extensionDir)
        .filter((entry): entry is string => entry !== null),
    ];
    fs.mkdirSync(binDir, { recursive: true });

    for (const extensionName of freshExtensionDirs) {
      const target = path.join(extensionsDir, extensionName);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "marker.txt"), `fresh-${extensionName}\n`);
    }
    fs.mkdirSync(path.join(extensionsDir, "stale-user-extension"), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir, "stale-user-extension", "marker.txt"), "stale\n");

    for (const extensionName of ["nemoclaw", ...options.backupExtensionDirs]) {
      const target = path.join(backupExtensionsDir, extensionName);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "marker.txt"), `old-${extensionName}\n`);
    }
    fs.mkdirSync(path.join(backupExtensionsDir, "user-extension"), { recursive: true });
    fs.writeFileSync(path.join(backupExtensionsDir, "user-extension", "marker.txt"), "restored\n");

    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(path.join(backupPath, "openclaw.json"), JSON.stringify(options.backupConfig));
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(options.freshConfig));
    const manifest: Record<string, unknown> = {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-08T12-00-00-000Z",
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: ["extensions"],
      backedUpDirs: ["extensions"],
      stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
      dir: OPENCLAW_DIR,
      backupPath,
      blueprintDigest: null,
      ...(options.previousPluginInstalls !== undefined
        ? { openclawImagePluginInstalls: options.previousPluginInstalls }
        : {}),
    };
    fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), JSON.stringify(manifest));

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
process.exit(0);
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
const openclawDir = ${JSON.stringify(openclawDir)};
const extensionsDir = ${JSON.stringify(extensionsDir)};
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ cmd }) + "\\n");
function readStdin() {
  const chunks = [];
  for (;;) {
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks);
}
if (cmd.includes("${OPENCLAW_DIR}/extensions") && cmd.includes("-exec rm -rf")) {
  const preserved = new Set(${JSON.stringify(freshExtensionDirs)});
  for (const entry of fs.readdirSync(extensionsDir)) {
    if (!preserved.has(entry)) fs.rmSync(path.join(extensionsDir, entry), { recursive: true, force: true });
  }
  process.exit(0);
}
if (cmd.includes("tar --no-same-owner -xf -")) {
  const result = spawnSync("tar", ["--no-same-owner", "-xf", "-", "-C", openclawDir], {
    input: readStdin(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.exit(result.status || 0);
}
if (cmd.includes("chown") || cmd.includes("[ -d ")) process.exit(0);
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.stdout.write(fs.readFileSync(path.join(openclawDir, "openclaw.json")));
  process.exit(0);
}
if (cmd.includes("openclaw.json") && cmd.includes(".nemoclaw-restore")) {
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), readStdin());
  process.exit(0);
}
process.exit(1);
`,
    );

    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const restore = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "openclaw",
      freshOpenClawImagePluginInstalls: options.freshPluginInstalls,
    });
    const loggedCommands = fs
      .readFileSync(sshLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).cmd as string);

    return {
      cleanupCommand: loggedCommands.find((command) => command.includes("-exec rm -rf")),
      freshMarkers: Object.fromEntries(
        freshExtensionDirs.map((name) => [
          name,
          fs.readFileSync(path.join(extensionsDir, name, "marker.txt"), "utf8"),
        ]),
      ),
      restore,
      restoredConfig: JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")),
      staleUserExtensionExists: fs.existsSync(path.join(extensionsDir, "stale-user-extension")),
      userExtensionMarker: fs.readFileSync(
        path.join(extensionsDir, "user-extension", "marker.txt"),
        "utf8",
      ),
    };
  } finally {
    restoreEnvBulk({ NEMOCLAW_OPENSHELL_BIN: previousOpenshellBin, PATH: previousPath });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function expectSuccessfulRestore(result: ReturnType<typeof runRestoreScenario>): void {
  expect(result.restore).toEqual({
    success: true,
    restoredDirs: ["extensions"],
    failedDirs: [],
    restoredFiles: ["openclaw.json"],
    failedFiles: [],
  });
  expect(result.staleUserExtensionExists).toBe(false);
  expect(result.userExtensionMarker).toBe("restored\n");
}

describe("recreated OpenClaw state restore", () => {
  it.each([
    { provenance: "missing legacy", previousPluginInstalls: undefined },
    { provenance: "known-empty", previousPluginInstalls: [] },
  ])("restores config and extensions with $provenance previous provenance", ({
    previousPluginInstalls,
  }) => {
    const weather = imageInstall("weather", "weather");
    const result = runRestoreScenario({
      previousPluginInstalls,
      freshPluginInstalls: [weather],
      backupExtensionDirs: ["weather"],
      backupConfig: {
        gateway: { auth: { token: "stale-token" } },
        mcpServers: { filesystem: { command: "npx" } },
        plugins: { entries: { "user-plugin": { enabled: true } } },
      },
      freshConfig: {
        gateway: { auth: { token: "fresh-token" } },
        plugins: {
          entries: { weather: { enabled: true, config: { revision: "fresh" } } },
          load: { paths: weather.loadPaths },
        },
      },
    });

    expectSuccessfulRestore(result);
    expect(result.freshMarkers).toEqual({
      nemoclaw: "fresh-nemoclaw\n",
      weather: "fresh-weather\n",
    });
    expect(result.restoredConfig.gateway.auth.token).toBe("fresh-token");
    expect(result.restoredConfig.mcpServers.filesystem.command).toBe("npx");
    expect(result.restoredConfig.plugins.entries).toEqual({
      "user-plugin": { enabled: true },
      weather: { enabled: true, config: { revision: "fresh" } },
    });
    expect(result.cleanupCommand).toContain("! -name 'nemoclaw'");
    expect(result.cleanupCommand).toContain("! -name 'weather'");
  });

  it("reconciles populated previous and fresh image-plugin provenance during config restore", () => {
    const previousWeather = imageInstall("weather", "weather-v1");
    const freshWeather = imageInstall("weather", "weather-v2");
    const userPluginPath = `${OPENCLAW_DIR}/extensions/user-plugin`;
    const result = runRestoreScenario({
      previousPluginInstalls: [previousWeather],
      freshPluginInstalls: [freshWeather],
      backupExtensionDirs: ["weather-v1"],
      backupConfig: {
        gateway: { auth: { token: "stale-token" } },
        channels: {
          weather: { enabled: false, token: "stale-image-token" },
          "user-channel": { room: "keep" },
        },
        plugins: {
          entries: {
            weather: { enabled: false, config: { revision: "stale" } },
            "user-plugin": { enabled: true },
          },
          installs: { weather: { installPath: previousWeather.installPath } },
          load: { paths: [previousWeather.installPath, userPluginPath] },
          slots: { memory: "weather", contextEngine: "user-plugin" },
        },
      },
      freshConfig: {
        gateway: { auth: { token: "fresh-token" } },
        channels: { weather: { enabled: true, endpoint: "fresh" } },
        plugins: {
          entries: { weather: { enabled: true, config: { revision: "fresh" } } },
          load: { paths: freshWeather.loadPaths },
          slots: { memory: "weather" },
        },
      },
    });

    expectSuccessfulRestore(result);
    expect(result.freshMarkers).toEqual({
      nemoclaw: "fresh-nemoclaw\n",
      "weather-v2": "fresh-weather-v2\n",
    });
    expect(result.restoredConfig.gateway.auth.token).toBe("fresh-token");
    expect(result.restoredConfig.channels).toEqual({
      weather: { enabled: true, endpoint: "fresh" },
      "user-channel": { room: "keep" },
    });
    expect(result.restoredConfig.plugins.entries).toEqual({
      "user-plugin": { enabled: true },
      weather: { enabled: true, config: { revision: "fresh" } },
    });
    expect(result.restoredConfig.plugins.load.paths).toEqual([
      freshWeather.installPath,
      userPluginPath,
    ]);
    expect(result.restoredConfig.plugins.slots).toEqual({
      contextEngine: "user-plugin",
      memory: "weather",
    });
    expect(result.restoredConfig.plugins.installs).toBeUndefined();
  });
});
