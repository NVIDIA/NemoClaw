// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";

import type { StateDirectoryCaptureRequest } from "../../../src/lib/state/sandbox";

// sandbox-state captures HOME when the module loads, so isolate its registry
// and rebuild backups before importing it.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-kanban-snapshot-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../../..", "src", "lib", "state", "sandbox.ts")).href
);

afterAll(() => {
  ORIGINAL_HOME === undefined ? delete process.env.HOME : (process.env.HOME = ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeHermesRegistry(): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "hermes",
      sandboxes: {
        hermes: {
          name: "hermes",
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: "hermes",
        },
      },
    }),
  );
}

function exerciseFailedKanbanBackup(options: { mode: "execute" | "empty-success"; name: string }): {
  success: boolean;
  backedUpFiles: string[];
  failedFiles: string[];
  localKanbanBackupExists: boolean;
  remoteKanbanStatus: number | null;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-kanban-failure-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const hermesDir = path.join(fixture, "sandbox-root", ".hermes");
    const remoteStatusPath = path.join(fixture, "remote-kanban-status");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(path.join(hermesDir, "kanban.db"), "not a sqlite database\n");

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-hermes\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
    );

    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
const mode = ${JSON.stringify(options.mode)};
if (mode === "empty-success") {
  if (cmd.includes("[ -d ")) process.exit(0);
  if (cmd.includes("nemoclaw-sqlite-backup") && cmd.includes("kanban.db")) process.exit(0);
  process.exit(2);
}
const mapped = cmd.split("/sandbox/.hermes").join(${JSON.stringify(hermesDir)});
const result = spawnSync("/bin/sh", ["-c", mapped], { stdio: "inherit" });
if (cmd.includes("nemoclaw-sqlite-backup") && cmd.includes("kanban.db")) {
  fs.writeFileSync(${JSON.stringify(remoteStatusPath)}, String(result.status));
}
process.exit(result.status === null ? 1 : result.status);
`,
    );

    writeHermesRegistry();
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("hermes", { name: options.name });
    return {
      success: backup.success,
      backedUpFiles: backup.backedUpFiles,
      failedFiles: backup.failedFiles,
      localKanbanBackupExists:
        backup.manifest !== undefined &&
        fs.existsSync(path.join(backup.manifest.backupPath, "kanban.db")),
      remoteKanbanStatus: fs.existsSync(remoteStatusPath)
        ? Number(fs.readFileSync(remoteStatusPath, "utf-8"))
        : null,
    };
  } finally {
    oldOpenshell === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
    oldPath === undefined ? delete process.env.PATH : (process.env.PATH = oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function exercisePermissionDeniedDirectoryCapture(archive: "declared" | "undeclared"): {
  backup: ReturnType<typeof sandboxState.backupSandboxState>;
  captureRequests: unknown[][];
  restoredMarker: string | null;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-directory-recovery-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const hermesDir = path.join(fixture, "sandbox-root", ".hermes");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(hermesDir, "memories"), { recursive: true });
    fs.mkdirSync(path.join(hermesDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(hermesDir, "memories", "marker.txt"), "preserved\n");
    fs.writeFileSync(path.join(hermesDir, "sessions", "outside.txt"), "undeclared\n");

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-hermes\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("cat --") || cmd.includes("nemoclaw-sqlite-backup")) process.exit(2);
if (cmd.includes("[ -d ")) {
  process.stdout.write("memories\\n");
  process.exit(0);
}
if (cmd.includes("find ")) process.exit(0);
if (cmd.includes("-cf -")) {
  process.stderr.write("tar: memories/marker.txt: Cannot open: Permission denied\\n");
  process.exit(2);
}
process.exit(2);
`,
    );

    writeHermesRegistry();
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
    const captureStateDirectories = vi.fn(
      (_request: StateDirectoryCaptureRequest, archiveFd: number) => {
        const names = archive === "declared" ? ["memories"] : ["memories", "sessions"];
        const result = spawnSync("tar", ["-cf", "-", "-C", hermesDir, ...names], {
          encoding: null,
        });
        expect(result.status).toBe(0);
        expect(Buffer.isBuffer(result.stdout)).toBe(true);
        fs.writeSync(archiveFd, result.stdout as Buffer);
        return { outcome: "backed_up" as const };
      },
    );
    const backup = sandboxState.backupSandboxState("hermes", {
      name: `directory-${archive}`,
      captureStateDirectories,
    });
    const markerPath = backup.manifest
      ? path.join(backup.manifest.backupPath, "memories", "marker.txt")
      : "";
    return {
      backup,
      captureRequests: captureStateDirectories.mock.calls,
      restoredMarker:
        markerPath && fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : null,
    };
  } finally {
    oldOpenshell === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
    oldPath === undefined ? delete process.env.PATH : (process.env.PATH = oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

it("recovers a permission-denied Hermes directory through the state-layer fallback (#10375)", () => {
  const result = exercisePermissionDeniedDirectoryCapture("declared");

  expect(
    result.backup.success,
    JSON.stringify({
      error: result.backup.error,
      backedUpDirs: result.backup.backedUpDirs,
      failedDirs: result.backup.failedDirs,
      failedDirReasons: result.backup.failedDirReasons,
      backedUpFiles: result.backup.backedUpFiles,
      failedFiles: result.backup.failedFiles,
    }),
  ).toBe(true);
  expect(result.backup.backedUpDirs).toEqual(["memories"]);
  expect(result.backup.failedDirs).toEqual([]);
  expect(result.backup.failedDirReasons).toBeUndefined();
  expect(result.restoredMarker).toBe("preserved\n");
  expect(result.captureRequests[0]?.[0]).toMatchObject({ dirs: ["memories"] });
});

it("rejects undeclared entries from privileged Hermes directory capture (#10375)", () => {
  const result = exercisePermissionDeniedDirectoryCapture("undeclared");

  expect(result.backup.success).toBe(false);
  expect(result.backup.backedUpDirs).toEqual([]);
  expect(result.backup.failedDirs).toEqual(["memories"]);
  expect(result.backup.failedDirReasons).toEqual({ memories: "permission denied" });
  expect(result.restoredMarker).toBeNull();
});

it("fails closed when the remote Hermes SQLite backup command fails (#7144)", () => {
  const result = exerciseFailedKanbanBackup({ mode: "execute", name: "invalid-kanban" });

  expect(result.success).toBe(false);
  expect(result.backedUpFiles).toEqual([]);
  expect(result.failedFiles).toEqual(["kanban.db"]);
  expect(result.localKanbanBackupExists).toBe(false);
  expect(result.remoteKanbanStatus).toBe(1);
});

it("rejects an empty Hermes SQLite backup payload (#7144)", () => {
  const result = exerciseFailedKanbanBackup({ mode: "empty-success", name: "empty-kanban" });

  expect(result.success).toBe(false);
  expect(result.backedUpFiles).toEqual([]);
  expect(result.failedFiles).toEqual(["kanban.db"]);
  expect(result.localKanbanBackupExists).toBe(false);
});

it("fails the SQLite state backup when the online backup command fails (#7095)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-backup-failure-"));
  try {
    const sourceDir = path.join(fixture, "state");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "kanban.db"), "source database\n");

    const command = sandboxState.buildStateFileBackupCommand(sourceDir, {
      path: "kanban.db",
      strategy: "sqlite_backup",
    });
    const result = spawnSync("sh", ["-c", command], {
      encoding: null,
    });

    expect(command).toContain("/usr/bin/python3 -I -S -c");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toHaveLength(0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
  "classifies an unreadable Hermes SQLite file before opening the database (#10375)",
  () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-backup-denied-"));
  try {
    const sourceDir = path.join(fixture, "state");
    const sourceFile = path.join(sourceDir, "kanban.db");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFile, "source database\n", { mode: 0o000 });

    const command = sandboxState.buildStateFileBackupCommand(sourceDir, {
      path: "kanban.db",
      strategy: "sqlite_backup",
    });
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`permission denied: ${sourceFile}`);
    expect(result.stdout).toBe("");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  },
);

it("preserves only the Hermes default-board database across rebuilds (#7095)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-kanban-state-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const hermesDir = path.join(fixture, "sandbox-root", ".hermes");
    const scratchFile = path.join(hermesDir, "kanban", "workspaces", "scratch", "work.txt");
    const namedBoardDb = path.join(hermesDir, "kanban", "boards", "release-board", "kanban.db");
    const attachmentFile = path.join(hermesDir, "kanban", "attachments", "t_1", "design.txt");
    const workerLog = path.join(hermesDir, "kanban", "logs", "t_1.log");
    const externalDirFile = path.join(fixture, "external-dir-workspace", "work.txt");
    const externalWorktreeFile = path.join(fixture, "external-worktree", "work.txt");
    const sshLog = path.join(fixture, "ssh-log.jsonl");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
    fs.mkdirSync(path.dirname(namedBoardDb), { recursive: true });
    fs.mkdirSync(path.dirname(attachmentFile), { recursive: true });
    fs.mkdirSync(path.dirname(workerLog), { recursive: true });
    fs.mkdirSync(path.dirname(externalDirFile), { recursive: true });
    fs.mkdirSync(path.dirname(externalWorktreeFile), { recursive: true });
    fs.writeFileSync(path.join(hermesDir, "kanban.db"), "original kanban database\n");
    fs.writeFileSync(scratchFile, "old scratch workspace\n");
    fs.writeFileSync(namedBoardDb, "old named-board database\n");
    fs.writeFileSync(attachmentFile, "old attachment\n");
    fs.writeFileSync(workerLog, "old worker log\n");
    fs.writeFileSync(externalDirFile, "old external dir workspace\n");
    fs.writeFileSync(externalWorktreeFile, "old external worktree\n");

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-hermes\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
    );

    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cmd = process.argv[process.argv.length - 1] || "";
const hermesDir = ${JSON.stringify(hermesDir)};
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
if (cmd.includes("[ -d ")) {
  process.exit(0);
}
if (cmd.includes("nemoclaw-sqlite-backup")) {
  if (!cmd.includes("kanban.db")) process.exit(2);
  process.stdout.write(fs.readFileSync(path.join(hermesDir, "kanban.db")));
  process.exit(0);
}
if (cmd.includes("SOUL.md") || cmd.includes(".hermes_history")) {
  process.exit(2);
}
if (cmd.includes("nemoclaw-sqlite-restore")) {
  fs.writeFileSync(path.join(hermesDir, "kanban.db"), readStdin());
  process.exit(0);
}
process.exit(0);
`,
    );

    writeHermesRegistry();
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("hermes", { name: "kanban-state" });
    expect(backup.success).toBe(true);
    expect(backup.backedUpFiles).toEqual(["kanban.db"]);
    expect(backup.failedFiles).toEqual([]);
    expect(backup.backedUpDirs).not.toContain("kanban");
    expect(backup.manifest?.stateDirs).not.toContain("kanban");
    expect(backup.manifest?.stateFiles).toContainEqual({
      path: "kanban.db",
      strategy: "sqlite_backup",
    });
    expect(fs.readFileSync(path.join(backup.manifest!.backupPath, "kanban.db"), "utf-8")).toBe(
      "original kanban database\n",
    );
    expect(fs.existsSync(path.join(backup.manifest!.backupPath, "kanban"))).toBe(false);

    fs.writeFileSync(path.join(hermesDir, "kanban.db"), "changed kanban database\n");
    fs.writeFileSync(scratchFile, "fresh scratch workspace\n");
    fs.writeFileSync(namedBoardDb, "fresh named-board database\n");
    fs.writeFileSync(attachmentFile, "fresh attachment\n");
    fs.writeFileSync(workerLog, "fresh worker log\n");
    fs.writeFileSync(externalDirFile, "fresh external dir workspace\n");
    fs.writeFileSync(externalWorktreeFile, "fresh external worktree\n");

    const restore = sandboxState.restoreSandboxState("hermes", backup.manifest!.backupPath);
    expect(restore.success).toBe(true);
    expect(restore.restoredFiles).toEqual(["kanban.db"]);
    expect(restore.restoredDirs).toEqual([]);
    expect(fs.readFileSync(path.join(hermesDir, "kanban.db"), "utf-8")).toBe(
      "original kanban database\n",
    );
    expect(fs.readFileSync(scratchFile, "utf-8")).toBe("fresh scratch workspace\n");
    expect(fs.readFileSync(namedBoardDb, "utf-8")).toBe("fresh named-board database\n");
    expect(fs.readFileSync(attachmentFile, "utf-8")).toBe("fresh attachment\n");
    expect(fs.readFileSync(workerLog, "utf-8")).toBe("fresh worker log\n");
    expect(fs.readFileSync(externalDirFile, "utf-8")).toBe("fresh external dir workspace\n");
    expect(fs.readFileSync(externalWorktreeFile, "utf-8")).toBe("fresh external worktree\n");

    const loggedCommands = fs.readFileSync(sshLog, "utf-8");
    expect(loggedCommands).toContain("/usr/bin/python3 -I -S -c");
    expect(loggedCommands).toContain("sqlite3.connect");
    expect(loggedCommands).not.toContain("tar -cf -");
    expect(loggedCommands).not.toContain("kanban/boards/release-board");
    expect(loggedCommands).not.toContain("kanban/attachments");
    expect(loggedCommands).not.toContain("kanban/logs");
    expect(loggedCommands).not.toContain(externalDirFile);
    expect(loggedCommands).not.toContain(externalWorktreeFile);
  } finally {
    oldOpenshell === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
    oldPath === undefined ? delete process.env.PATH : (process.env.PATH = oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
