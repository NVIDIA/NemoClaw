// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stale-dir-restore-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import("../src/lib/state/sandbox.js");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function writeOpenClawRegistry(sandboxName: string): void {
  const stateRoot = path.join(TMP_HOME, ".nemoclaw");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
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
}
process.exit(0);
`,
  );
  return openshell;
}

it("clears directories absent from a complete backup while preserving managed extensions (#7428)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-absent-dirs-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const sshLog = path.join(fixture, "ssh-log.jsonl");
    fs.mkdirSync(binDir, { recursive: true });

    const openshell = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ cmd }) + "\\n");
if (cmd.includes("[ -d ") && cmd.includes("printf")) {
  process.exit(0);
}
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.exit(2);
}
if (cmd.includes("rm -rf")) {
  process.exit(0);
}
process.exit(0);
`,
    );

    writeOpenClawRegistry("alpha");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success).toBe(true);
    expect(backup.manifest?.backedUpDirs).toEqual([]);
    expect(backup.manifest?.failedBackupDirs).toEqual([]);

    const restore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
    expect(restore.success).toBe(true);
    expect(restore.restoredDirs).toEqual([]);

    const loggedCommands = fs
      .readFileSync(sshLog, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).cmd as string);
    const cleanupCommand = loggedCommands.find((cmd) =>
      cmd.includes("d='/sandbox/.openclaw/workspace'"),
    );
    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand).toContain("! -name 'nemoclaw'");
    expect(cleanupCommand).toContain("! -name 'openclaw-weixin'");
    expect(cleanupCommand).not.toContain("rm -rf -- '/sandbox/.openclaw/extensions'");
    expect(cleanupCommand).not.toContain("d='/sandbox/.openclaw/extensions'");
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    process.env.PATH = oldPath;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
