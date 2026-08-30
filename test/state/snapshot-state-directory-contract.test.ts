// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-state-contract-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "../..");
type SandboxStateModule = typeof import("../../src/lib/state/sandbox.js");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as SandboxStateModule;
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function writeBackup(
  sandboxName: string,
  dirName: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(backupPath, { recursive: true });
  const manifest = {
    version: 1,
    sandboxName,
    timestamp: dirName,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox/.openclaw",
    backupPath,
    blueprintDigest: null,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

function writeAgentRegistry(sandboxName: string, agent: string): void {
  const registryDir = path.join(TMP_HOME, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent,
        },
      },
    }),
  );
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeFakeOpenshell(binDir: string): string {
  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write(\`Host openshell-\${args.at(-1)}\\n  HostName 127.0.0.1\\n  User sandbox\\n\`);
  process.exit(0);
}
process.exit(0);
`,
  );
  return openshell;
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("snapshot state-directory authorization", () => {
  it("refuses a snapshot directory removed from the current agent contract (#8006)", () => {
    const manifest = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["retired-state"],
      backedUpDirs: ["retired-state"],
    });
    fs.mkdirSync(path.join(String(manifest.backupPath), "retired-state"));
    writeAgentRegistry("test-sandbox", "openclaw");

    const restore = sandboxState.restoreSandboxState("test-sandbox", String(manifest.backupPath));

    expect(restore).toMatchObject({
      success: false,
      restoredDirs: [],
      failedDirs: ["retired-state"],
      error: "Backup state directories are not declared by target agent 'openclaw': retired-state",
    });
  });

  it.each([
    ["workspace-research", { success: true }],
    [
      "workspace-research/nested",
      {
        success: false,
        error:
          "Backup state directories are not declared by target agent 'openclaw': workspace-research/nested",
      },
    ],
  ])(
    "authorizes only a top-level concrete match for a dynamic state prefix: %s (#8006)",
    (stateDir, expected) => {
      const manifest = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
        stateDirs: [stateDir],
        backedUpDirs: [],
        failedBackupDirs: [stateDir],
      });
      writeAgentRegistry("test-sandbox", "openclaw");

      const restore = sandboxState.restoreSandboxState("test-sandbox", String(manifest.backupPath));

      expect(restore).toMatchObject(expected);
    },
  );

  it.each([
    ["hermes", "hermes"],
    ["deepagents", "langchain-deepagents-code"],
  ])(
    "keeps optional exact-directory discovery successful for %s when no state directory exists (#8006)",
    (sandboxName, agentName) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exact-dir-discovery-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      try {
        const binDir = path.join(fixture, "bin");
        const discoveryLog = path.join(fixture, "discovery.json");
        fs.mkdirSync(binDir, { recursive: true });
        const openshell = writeFakeOpenshell(binDir);
        writeExecutable(
          path.join(binDir, "ssh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.startsWith("{ ")) {
  const result = spawnSync("/bin/sh", ["-c", cmd], { stdio: "ignore" });
  const status = result.status ?? 127;
  fs.writeFileSync(${JSON.stringify(discoveryLog)}, JSON.stringify({ cmd, status }));
  process.exit(status);
}
process.exit(1);
`,
        );
        writeAgentRegistry(sandboxName, agentName);
        process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
        process.env.PATH = `${binDir}:${oldPath || ""}`;

        sandboxState.backupSandboxState(sandboxName);

        const discovery = JSON.parse(fs.readFileSync(discoveryLog, "utf8")) as {
          cmd: string;
          status: number;
        };
        expect(discovery.status).toBe(0);
        expect(discovery.cmd).toMatch(/; :; } 2>\/dev\/null$/);
      } finally {
        restoreEnv("PATH", oldPath);
        restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
