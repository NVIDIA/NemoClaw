// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../src/lib/state/sandbox.js");

const spec = { path: "openclaw.json", strategy: "copy" } as const;

describe("buildStateFileRestoreCommand (#5202)", () => {
  it("refreshes the OpenClaw .last-good anchor before swapping the live config", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, true);

    // The anchor write targets openclaw.json.last-good and rejects symlinks.
    expect(cmd).toContain('last_good="${dst}.last-good"');
    expect(cmd).toContain("refusing symlinked last-good target");

    // The anchor is staged through a temp and installed via atomic rename, and
    // fails closed (exit 14) so a partial write never reaches .last-good.
    expect(cmd).toContain(".nemoclaw-lastgood.XXXXXX");
    expect(cmd).toContain('mv -f "$anchor_tmp" "$last_good"');
    expect(cmd).toContain("exit 14");

    // Anchor must be installed BEFORE the live file is swapped, so OpenClaw's
    // integrity watcher never observes a config that disagrees with .last-good.
    const anchorIdx = cmd.indexOf('mv -f "$anchor_tmp" "$last_good"');
    const swapIdx = cmd.indexOf('mv -f "$tmp" "$dst"');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(anchorIdx);

    // The .config-hash is still refreshed after the swap.
    expect(cmd).toContain("sha256sum");
  });

  it("does not touch the .last-good anchor for non-OpenClaw state restores", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, false);
    expect(cmd).not.toContain("last-good");
    expect(cmd).not.toContain("sha256sum");
    expect(cmd).toContain('mv -f "$tmp" "$dst"');
  });

  it("isolates SQLite restore from an agent-managed Python environment (#7144)", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand(
      "/sandbox/.hermes",
      { path: "kanban.db", strategy: "sqlite_backup" },
      false,
    );

    expect(cmd).toContain("/usr/bin/python3 -I -S -c");
    expect(cmd).not.toMatch(/(?:^|[; ])python3 -c/u);
  });

  const SANDBOX_PYTHON = "/usr/bin/python3";
  const canRunSqliteRestore = process.platform === "linux" && fs.existsSync(SANDBOX_PYTHON);
  const makeDb = (file: string, table: string) => {
    const result = spawnSync(SANDBOX_PYTHON, [
      "-c",
      `import sqlite3; c = sqlite3.connect(${JSON.stringify(file)}); c.execute("CREATE TABLE ${table}(x)"); c.commit(); c.close()`,
    ]);
    expect(result.status).toBe(0);
  };

  it.skipIf(!canRunSqliteRestore)(
    "restores over a gateway-owned SQLite database the restoring user cannot write (#7312)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-"));
      try {
        const dst = path.join(dir, "state.db");
        makeDb(dst, "live");
        // The Hermes gateway creates the live database as the gateway user
        // with no group-write bit; group-read-only reproduces that boundary
        // for the restoring user.
        fs.chmodSync(dst, 0o440);
        fs.writeFileSync(`${dst}-wal`, "stale");
        fs.writeFileSync(`${dst}-shm`, "stale");
        const backupDb = path.join(dir, "backup.db");
        makeDb(backupDb, "restored");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], { input: fs.readFileSync(backupDb) });

        expect(result.stderr.toString()).toBe("");
        expect(result.status).toBe(0);
        const tables = spawnSync(SANDBOX_PYTHON, [
          "-c",
          `import sqlite3; print(sqlite3.connect(${JSON.stringify(dst)}).execute("SELECT name FROM sqlite_master").fetchall())`,
        ]);
        expect(tables.stdout.toString()).toContain("restored");
        expect(fs.existsSync(`${dst}-wal`)).toBe(false);
        expect(fs.existsSync(`${dst}-shm`)).toBe(false);
        expect(fs.statSync(dst).mode & 0o777).toBe(0o660);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canRunSqliteRestore)(
    "preserves the live SQLite database and sidecars when backup validation fails (#7312)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-invalid-"));
      try {
        const dst = path.join(dir, "state.db");
        makeDb(dst, "live");
        const originalDatabase = fs.readFileSync(dst);
        fs.chmodSync(dst, 0o440);
        fs.writeFileSync(`${dst}-wal`, "live wal");
        fs.writeFileSync(`${dst}-shm`, "live shm");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("not a sqlite database"),
        });

        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(dst)).toEqual(originalDatabase);
        expect(fs.statSync(dst).mode & 0o777).toBe(0o440);
        expect(fs.readFileSync(`${dst}-wal`, "utf8")).toBe("live wal");
        expect(fs.readFileSync(`${dst}-shm`, "utf8")).toBe("live shm");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canRunSqliteRestore)(
    "refuses a symlinked SQLite state parent without writing through it (#7312)",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-parent-link-"));
      try {
        const realParent = path.join(root, "real");
        const linkedParent = path.join(root, "linked");
        fs.mkdirSync(realParent);
        fs.symlinkSync(realParent, linkedParent, "dir");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          linkedParent,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("not a sqlite database"),
        });

        expect(result.status).toBe(10);
        expect(fs.readdirSync(realParent)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canRunSqliteRestore)(
    "refuses a symlinked SQLite target without replacing its destination (#7312)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-target-link-"));
      try {
        const realDatabase = path.join(dir, "real.db");
        const linkedDatabase = path.join(dir, "state.db");
        makeDb(realDatabase, "live");
        const originalDatabase = fs.readFileSync(realDatabase);
        fs.symlinkSync(realDatabase, linkedDatabase);

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("not a sqlite database"),
        });

        expect(result.status).toBe(11);
        expect(fs.lstatSync(linkedDatabase).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(realDatabase)).toEqual(originalDatabase);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
