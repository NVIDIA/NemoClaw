// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadAgent } from "../../../src/lib/agent/defs.ts";

const originalHome = process.env.HOME;
const snapshotHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-snapshot-home-"));
process.env.HOME = snapshotHome;
const sandboxState = await import("../../../src/lib/state/sandbox.ts");
const { buildStateFileBackupCommand, buildStateFileRestoreCommand } = sandboxState;

const sandboxPython = "/usr/bin/python3";
const canRunSqlite = process.platform === "linux" && fs.existsSync(sandboxPython);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(snapshotHome, { recursive: true, force: true });
});

function tempFixture(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ledger-"));
  fixtures.push(fixture);
  return fixture;
}

function createLedger(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const result = spawnSync(sandboxPython, [
    "-I",
    "-S",
    "-c",
    [
      "import sqlite3, sys",
      "db = sqlite3.connect(sys.argv[1])",
      "db.execute('CREATE TABLE ledger(value TEXT NOT NULL)')",
      "db.execute('INSERT INTO ledger(value) VALUES (?)', (sys.argv[2],))",
      "db.commit()",
      "db.close()",
    ].join("; "),
    filePath,
    value,
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
}

function readLedger(filePath: string): string {
  const result = spawnSync(sandboxPython, [
    "-I",
    "-S",
    "-c",
    "import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT value FROM ledger').fetchone()[0])",
    filePath,
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

describe("Hermes 0.19 durable state ledgers", () => {
  it("declares online backups for the cron and Discord recovery databases", () => {
    const hermes = loadAgent("hermes");

    expect(hermes.stateDirs).toContain("cron");
    expect(hermes.stateFiles).toEqual(
      expect.arrayContaining([
        { path: "runtime/cron-executions.db", strategy: "sqlite_backup" },
        { path: "gateway/discord_message_recovery.db", strategy: "sqlite_backup" },
      ]),
    );
  });

  it.skipIf(!canRunSqlite)("backs up and restores the nested cron execution ledger online", () => {
    const fixture = tempFixture();
    const hermesHome = path.join(fixture, ".hermes");
    const liveDb = path.join(hermesHome, "runtime", "cron-executions.db");
    const backupDb = path.join(fixture, "backup", "runtime", "cron-executions.db");
    createLedger(liveDb, "online-copy");

    fs.mkdirSync(path.dirname(backupDb), { recursive: true });
    const backup = spawnSync(
      "sh",
      [
        "-c",
        buildStateFileBackupCommand(hermesHome, {
          path: "runtime/cron-executions.db",
          strategy: "sqlite_backup",
        }),
      ],
      { encoding: null },
    );
    expect(backup.status, backup.stderr.toString()).toBe(0);
    fs.writeFileSync(backupDb, backup.stdout);
    expect(readLedger(backupDb)).toBe("online-copy");

    fs.rmSync(liveDb);
    createLedger(liveDb, "stale-directory-copy");
    fs.writeFileSync(`${liveDb}-wal`, "stale wal\n");
    fs.writeFileSync(`${liveDb}-shm`, "stale shm\n");
    const restore = spawnSync(
      "sh",
      [
        "-c",
        buildStateFileRestoreCommand(
          hermesHome,
          { path: "runtime/cron-executions.db", strategy: "sqlite_backup" },
          false,
        ),
      ],
      { input: fs.readFileSync(backupDb) },
    );

    expect(restore.status, restore.stderr.toString()).toBe(0);
    expect(readLedger(liveDb)).toBe("online-copy");
    expect(fs.existsSync(`${liveDb}-wal`)).toBe(false);
    expect(fs.existsSync(`${liveDb}-shm`)).toBe(false);
  });

  it.skipIf(!canRunSqlite)(
    "recreates the nested Discord recovery parent before restoring its database",
    () => {
      const fixture = tempFixture();
      const hermesHome = path.join(fixture, ".hermes");
      const backupDb = path.join(fixture, "discord-message-recovery.db");
      const restoredDb = path.join(hermesHome, "gateway", "discord_message_recovery.db");
      createLedger(backupDb, "discord-recovery");

      const restore = spawnSync(
        "sh",
        [
          "-c",
          buildStateFileRestoreCommand(
            hermesHome,
            { path: "gateway/discord_message_recovery.db", strategy: "sqlite_backup" },
            false,
          ),
        ],
        { input: fs.readFileSync(backupDb) },
      );

      expect(restore.status, restore.stderr.toString()).toBe(0);
      expect(readLedger(restoredDb)).toBe("discord-recovery");
    },
  );

  it("backs up and restores every default-profile ledger without replacing the new API key", () => {
    const fixture = tempFixture();
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const binDir = path.join(fixture, "bin");
    const fakeRoot = path.join(fixture, "sandbox-root");
    const hermesHome = path.join(fakeRoot, ".hermes");
    const envPath = path.join(hermesHome, ".env");
    const sshLog = path.join(fixture, "ssh-log.jsonl");
    const ledgers = [
      ["runtime/state.db", "original sqlite backup\n"],
      ["runtime/cron-executions.db", "original cron backup\n"],
      ["gateway/discord_message_recovery.db", "original Discord backup\n"],
    ] as const;
    const readText = (filePath: string) => fs.readFileSync(filePath, "utf8");
    try {
      fs.mkdirSync(binDir, { recursive: true });
      ledgers.forEach(([relativePath, content]) => {
        const target = path.join(hermesHome, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      });
      fs.writeFileSync(path.join(hermesHome, "SOUL.md"), "original soul\n");
      fs.writeFileSync(path.join(hermesHome, ".hermes_history"), "original history\n");
      fs.writeFileSync(path.join(hermesHome, "config.yaml"), "token: should-not-copy\n");
      fs.writeFileSync(envPath, `API_SERVER_KEY=${"a".repeat(64)}\n`);
      fs.writeFileSync(path.join(hermesHome, "auth.json"), '{"token":"should-not-copy"}\n');

      const openshell = path.join(binDir, "openshell");
      fs.writeFileSync(
        openshell,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-hermes\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const hermesHome = path.join(${JSON.stringify(fakeRoot)}, ".hermes");
const cmd = process.argv[process.argv.length - 1] || "";
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ cmd }) + "\\n");
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
const ledger = [
  "runtime/state.db",
  "runtime/cron-executions.db",
  "gateway/discord_message_recovery.db",
].find((candidate) => cmd.includes(candidate));
if (cmd.includes("[ -d ")) process.exit(0);
if (cmd.includes("nemoclaw-sqlite-backup")) {
  if (cmd.includes("kanban.db")) process.exit(2);
  process.stdout.write(fs.readFileSync(path.join(hermesHome, ledger)));
  process.exit(0);
}
for (const name of ["SOUL.md", ".hermes_history"]) {
  if (cmd.includes(name) && cmd.includes("cat --")) {
    process.stdout.write(fs.readFileSync(path.join(hermesHome, name)));
    process.exit(0);
  }
}
if (cmd.includes("nemoclaw-sqlite-restore")) {
  const target = path.join(hermesHome, ledger);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, readStdin());
  process.exit(0);
}
for (const name of ["SOUL.md", ".hermes_history"]) {
  if (cmd.includes(name) && cmd.includes(".nemoclaw-restore")) {
    fs.writeFileSync(path.join(hermesHome, name), readStdin());
    process.exit(0);
  }
}
`,
        { mode: 0o755 },
      );
      fs.mkdirSync(path.join(snapshotHome, ".nemoclaw"), { recursive: true });
      fs.writeFileSync(
        path.join(snapshotHome, ".nemoclaw", "sandboxes.json"),
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
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = sandboxState.backupSandboxState("hermes", { name: "hermes-state" });
      expect(backup.success).toBe(true);
      const backupPath = backup.manifest!.backupPath;
      expect(backup.backedUpFiles).toEqual([
        "SOUL.md",
        ".hermes_history",
        ...ledgers.map(([relativePath]) => relativePath),
      ]);
      expect(backup.failedFiles).toEqual([]);
      ledgers.forEach(([relativePath, content]) => {
        expect(readText(path.join(backupPath, relativePath))).toBe(content);
        fs.writeFileSync(path.join(hermesHome, relativePath), "changed\n");
      });
      expect(fs.existsSync(path.join(backupPath, "config.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(backupPath, ".env"))).toBe(false);
      expect(fs.existsSync(path.join(backupPath, "auth.json"))).toBe(false);

      const replacementEnv = `API_SERVER_KEY=${"b".repeat(64)}\n`;
      fs.writeFileSync(envPath, replacementEnv);
      const restore = sandboxState.restoreSandboxState("hermes", backupPath);
      expect(restore.success).toBe(true);
      expect(restore.restoredFiles).toEqual(backup.backedUpFiles);
      expect(ledgers.every(([relativePath, content]) =>
          Object.is(readText(path.join(hermesHome, relativePath)), content))).toBe(true);
      expect(readText(envPath)).toBe(replacementEnv);
      const loggedCommands = readText(sshLog);
      expect(loggedCommands).toContain("src_conn.backup(dst_conn)");
      expect(loggedCommands).toContain("PRAGMA quick_check");
    } finally {
      oldOpenshell === undefined
        ? Reflect.deleteProperty(process.env, "NEMOCLAW_OPENSHELL_BIN")
        : Reflect.set(process.env, "NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      process.env.PATH = oldPath;
    }
  });
});
