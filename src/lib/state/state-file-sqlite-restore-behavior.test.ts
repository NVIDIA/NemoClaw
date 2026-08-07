// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildStateFileRestoreCommand } from "./state-file-restore";

const CREATE_SOURCE_DB_PY = [
  "import sqlite3, sys",
  "conn = sqlite3.connect(sys.argv[1])",
  "conn.execute('CREATE TABLE sessions (id TEXT)')",
  "conn.execute(\"INSERT INTO sessions VALUES ('restored')\")",
  "conn.commit()",
  "conn.close()",
].join("\n");

const WRITE_TO_DB_PY = [
  "import sqlite3, sys",
  "conn = sqlite3.connect(sys.argv[1])",
  "conn.execute(\"INSERT INTO sessions VALUES ('after-restore')\")",
  "conn.commit()",
  "print(conn.execute('SELECT count(*) FROM sessions').fetchone()[0])",
  "conn.close()",
].join("\n");

const hasSystemPython = fs.existsSync("/usr/bin/python3");
const fixtures: string[] = [];

function makeFixture(): { dir: string; backup: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-"));
  fixtures.push(dir);
  const sourceDb = path.join(dir, "source.db");
  execFileSync("/usr/bin/python3", ["-c", CREATE_SOURCE_DB_PY, sourceDb]);
  return { dir, backup: fs.readFileSync(sourceDb) };
}

function occupyRollbackJournalPath(restored: string): void {
  fs.mkdirSync(`${restored}-journal`, { recursive: true });
}

function runRestore(stateDir: string, backup: Buffer): { status: number | null; stderr: string } {
  const command = buildStateFileRestoreCommand(stateDir, {
    path: "runtime/state.db",
    strategy: "sqlite_backup",
  });
  const result = spawnSync("bash", ["-c", command], { input: backup });
  return { status: result.status, stderr: result.stderr.toString() };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe.skipIf(!hasSystemPython)("sqlite state-file restore", () => {
  it("leaves the restored database writable and free of stale sidecars", () => {
    const { dir, backup } = makeFixture();
    const stateDir = path.join(dir, "state");
    const restored = path.join(stateDir, "runtime", "state.db");
    fs.mkdirSync(path.join(stateDir, "runtime"), { recursive: true });
    fs.writeFileSync(`${restored}-wal`, "stale");
    fs.writeFileSync(`${restored}-shm`, "stale");

    const result = runRestore(stateDir, backup);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(fs.existsSync(`${restored}-wal`)).toBe(false);
    expect(fs.existsSync(`${restored}-shm`)).toBe(false);
    const rows = execFileSync("/usr/bin/python3", ["-c", WRITE_TO_DB_PY, restored]).toString();
    expect(rows.trim()).toBe("2");
  });

  it("reports failure when the swapped database cannot open a write transaction", () => {
    const { dir, backup } = makeFixture();
    const stateDir = path.join(dir, "state");
    const restored = path.join(stateDir, "runtime", "state.db");
    fs.mkdirSync(path.join(stateDir, "runtime"), { recursive: true });
    occupyRollbackJournalPath(restored);

    const result = runRestore(stateDir, backup);

    expect(fs.existsSync(restored)).toBe(true);
    expect(result.stderr).toContain(`restored database is not writable: ${restored}`);
    expect(result.status).toBe(12);
  });
});
