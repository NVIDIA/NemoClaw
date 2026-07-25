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
  restoreEnv("HOME", ORIGINAL_HOME);
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

function writeSandboxRegistry(sandboxName: string, agent: string | null = null): void {
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
          agent,
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

it("clears snapshot-declared absent directories while preserving target-only state (#7428)", () => {
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

    writeSandboxRegistry("alpha");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success).toBe(true);
    expect(backup.manifest?.backedUpDirs).toEqual([]);
    expect(backup.manifest?.failedBackupDirs).toEqual([]);
    const manifestPath = path.join(backup.manifest!.backupPath, "rebuild-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.stateDirs).toContain("agents");
    manifest.stateDirs = manifest.stateDirs.filter((stateDir: string) => stateDir !== "agents");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

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
    expect(loggedCommands).not.toEqual(
      expect.arrayContaining([expect.stringContaining("d='/sandbox/.openclaw/agents'")]),
    );
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it("clears a Hermes directory declared absent by the snapshot (#7428)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-absent-dir-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const workspaceMarker = path.join(fixture, "workspace-content");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(workspaceMarker, "stale");

    const openshell = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("[ -d ") && cmd.includes("printf")) {
  process.exit(0);
}
if (
  cmd.includes("/sandbox/.hermes/SOUL.md") ||
  cmd.includes("/sandbox/.hermes/.hermes_history") ||
  cmd.includes("/sandbox/.hermes/runtime/state.db") ||
  cmd.includes("/sandbox/.hermes/kanban.db")
) {
  process.exit(2);
}
if (cmd.includes("d='/sandbox/.hermes/workspace'")) {
  fs.rmSync(${JSON.stringify(workspaceMarker)}, { force: true });
}
process.exit(0);
`,
    );

    writeSandboxRegistry("alpha", "hermes");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success).toBe(true);
    expect(backup.manifest?.stateDirs).toContain("workspace");
    expect(backup.manifest?.backedUpDirs).not.toContain("workspace");
    expect(backup.manifest?.failedBackupDirs).not.toContain("workspace");

    const restore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

    expect(restore.success).toBe(true);
    expect(fs.existsSync(workspaceMarker)).toBe(false);
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it("preserves stale content for directories whose backup failed (#7428)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-failed-dir-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const sshLog = path.join(fixture, "ssh-log.jsonl");
    const workspaceMarker = path.join(fixture, "workspace-content");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(workspaceMarker, "preserve");

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
if (cmd.includes("d='/sandbox/.openclaw/workspace'")) {
  fs.rmSync(${JSON.stringify(workspaceMarker)}, { force: true });
}
process.exit(0);
`,
    );

    writeSandboxRegistry("alpha");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success).toBe(true);
    const manifestPath = path.join(backup.manifest!.backupPath, "rebuild-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.failedBackupDirs = ["workspace"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const restore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

    expect(restore.success).toBe(true);
    const cleanupCommands = fs
      .readFileSync(sshLog, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).cmd as string)
      .filter((cmd) => cmd.includes("rm -rf"));
    expect(cleanupCommands).not.toEqual(
      expect.arrayContaining([expect.stringContaining("d='/sandbox/.openclaw/workspace'")]),
    );
    expect(fs.existsSync(workspaceMarker)).toBe(true);

    Reflect.deleteProperty(manifest, "failedBackupDirs");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(sshLog, "");
    const legacyRestore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

    expect(legacyRestore.success).toBe(true);
    expect(fs.readFileSync(sshLog, "utf-8")).not.toContain("d='/sandbox/.openclaw/workspace'");
    expect(fs.existsSync(workspaceMarker)).toBe(true);
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it("reports stale directories when restore cannot obtain SSH configuration (#7428)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stale-dir-ssh-failure-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const openshell = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("[ -d ") && cmd.includes("printf")) {
  process.exit(0);
}
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.exit(2);
}
process.exit(0);
`,
    );

    writeSandboxRegistry("alpha");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
    const backup = sandboxState.backupSandboxState("alpha");
    expect(backup.success).toBe(true);
    expect(backup.manifest?.failedBackupDirs).toEqual([]);

    const failingOpenshell = path.join(binDir, "openshell-fail");
    writeExecutable(failingOpenshell, "#!/usr/bin/env node\nprocess.exit(1);\n");
    process.env.NEMOCLAW_OPENSHELL_BIN = failingOpenshell;
    const restore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);

    expect(restore.success).toBe(false);
    expect(restore.failedDirs).toEqual(
      expect.arrayContaining(["agents", "extensions", "workspace"]),
    );
  } finally {
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
