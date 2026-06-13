// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-restore-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

type SandboxStateModule = typeof import("../dist/lib/state/sandbox.js");
type CurrentOpenClawReadMode = "file" | "missing" | "invalid-json";

const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "dist", "lib", "state", "sandbox.js")).href
)) as SandboxStateModule;

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeOpenClawRegistry(sandboxName: string): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: null,
        },
      },
    }),
  );
}

function writeFakeOpenshell(binDir: string): string {
  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return openshell;
}

function writeBackup(sandboxName: string, dirName: string): { backupPath: string } {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sandboxName,
        timestamp: dirName,
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
        dir: "/sandbox/.openclaw",
        backupPath,
        blueprintDigest: null,
      },
      null,
      2,
    ),
  );
  return { backupPath };
}

function freshRuntimeConfig(): string {
  return JSON.stringify(
    {
      gateway: { auth: { token: "fresh-runtime-token" } },
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
      },
      models: {
        providers: { nvidia: { apiKey: "unused", models: [{ id: "nvidia/nemotron" }] } },
      },
    },
    null,
    2,
  );
}

function staleBackupConfig(): string {
  return JSON.stringify(
    {
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
        slack: { accounts: { default: { botToken: "[STRIPPED_BY_MIGRATION]" } } },
      },
      models: {
        providers: { nvidia: { apiKey: "unused", models: [{ id: "stale-model" }] } },
      },
      mcpServers: { filesystem: { command: "npx" } },
    },
    null,
    2,
  );
}

function restoreOpenClawStateFileWithFakeSsh(options: {
  backupContents: string;
  currentContents: string;
  currentReadMode?: CurrentOpenClawReadMode;
}): {
  restore: ReturnType<SandboxStateModule["restoreSandboxState"]>;
  currentContents: string;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-restore-fixture-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const fakeRoot = path.join(fixture, "sandbox-root");
    const openclawDir = path.join(fakeRoot, ".openclaw");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), options.currentContents);

    process.env.NEMOCLAW_OPENSHELL_BIN = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = path.join(${JSON.stringify(fakeRoot)}, ".openclaw");
const cmd = process.argv[process.argv.length - 1] || "";
const currentReadMode = ${JSON.stringify(options.currentReadMode ?? "file")};
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { break; }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  if (currentReadMode === "missing") process.exit(2);
  if (currentReadMode === "invalid-json") {
    process.stdout.write("{ invalid current json");
    process.exit(0);
  }
  process.stdout.write(fs.readFileSync(path.join(dir, "openclaw.json")));
  process.exit(0);
}
if (cmd.includes(".nemoclaw-restore") && cmd.includes("openclaw.json")) {
  fs.writeFileSync(path.join(dir, "openclaw.json"), readStdin());
  process.exit(0);
}
process.exit(0);
`,
    );

    writeOpenClawRegistry("alpha");
    process.env.PATH = `${binDir}:${oldPath || ""}`;

    const { backupPath } = writeBackup("alpha", "2026-06-10T20-00-00-000Z");
    fs.writeFileSync(path.join(backupPath, "openclaw.json"), options.backupContents);

    const restore = sandboxState.restoreSandboxState("alpha", backupPath);
    return {
      restore,
      currentContents: fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf-8"),
    };
  } finally {
    if (oldOpenshell === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
    }
    process.env.PATH = oldPath;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe("OpenClaw config restore failure modes", () => {
  it("fails closed when the current rebuilt openclaw.json cannot be read", () => {
    const { restore, currentContents } = restoreOpenClawStateFileWithFakeSsh({
      backupContents: staleBackupConfig(),
      currentContents: freshRuntimeConfig(),
      currentReadMode: "missing",
    });

    expect(restore.success).toBe(false);
    expect(restore.restoredFiles).toEqual([]);
    expect(restore.failedFiles).toEqual(["openclaw.json"]);
    expect(JSON.parse(currentContents).gateway.auth.token).toBe("fresh-runtime-token");
    expect(JSON.parse(currentContents).channels.slack).toBeUndefined();
  });

  it("fails closed when the current rebuilt openclaw.json is invalid JSON", () => {
    const { restore, currentContents } = restoreOpenClawStateFileWithFakeSsh({
      backupContents: staleBackupConfig(),
      currentContents: freshRuntimeConfig(),
      currentReadMode: "invalid-json",
    });

    expect(restore.success).toBe(false);
    expect(restore.restoredFiles).toEqual([]);
    expect(restore.failedFiles).toEqual(["openclaw.json"]);
    expect(JSON.parse(currentContents).gateway.auth.token).toBe("fresh-runtime-token");
    expect(JSON.parse(currentContents).models.providers.nvidia.models[0].id).toBe(
      "nvidia/nemotron",
    );
  });

  it("fails closed when the backed-up openclaw.json is invalid JSON", () => {
    const { restore, currentContents } = restoreOpenClawStateFileWithFakeSsh({
      backupContents: "{ invalid backup json",
      currentContents: freshRuntimeConfig(),
    });

    expect(restore.success).toBe(false);
    expect(restore.restoredFiles).toEqual([]);
    expect(restore.failedFiles).toEqual(["openclaw.json"]);
    expect(JSON.parse(currentContents).gateway.auth.token).toBe("fresh-runtime-token");
    expect(JSON.parse(currentContents).channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:v222_TOKEN",
    );
  });
});
