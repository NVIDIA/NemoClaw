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

  it("uses the system Python runtime for SQLite restores", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand(
      "/sandbox/.hermes",
      { path: "kanban.db", strategy: "sqlite_backup" },
      false,
    );

    expect(cmd).toContain("/usr/bin/python3 -I -c");
  });

  it("stages SQLite restores and replaces the live database atomically (#7312)", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand(
      "/sandbox/.hermes",
      { path: "runtime/state.db", strategy: "sqlite_backup" },
      false,
    );

    // Python validates the backup into a staged copy this user owns; it never
    // opens the gateway-owned live database for writing.
    expect(cmd).toContain(".nemoclaw-sqlite-staged.XXXXXX");
    expect(cmd).toContain('"$tmp" "$staged"');
    expect(cmd).not.toContain('"$tmp" "$dst"');
    expect(cmd).not.toContain("os.chmod");

    // The mode fix targets the staged copy before the swap, and the stale
    // WAL/SHM sidecars of the replaced database are dropped after it.
    const chmodIdx = cmd.indexOf('chmod 660 "$staged"');
    const swapIdx = cmd.indexOf('mv -f "$staged" "$dst"');
    const sidecarIdx = cmd.indexOf('rm -f -- "${dst}-wal" "${dst}-shm"');
    expect(chmodIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(chmodIdx);
    expect(sidecarIdx).toBeGreaterThan(swapIdx);

    // Both symlink guards stay in place ahead of any write.
    expect(cmd).toContain("refusing symlinked state parent");
    expect(cmd).toContain("refusing symlinked sqlite target");
  });

  const SANDBOX_PYTHON = "/usr/bin/python3";
  const canRunSqliteRestore = process.platform === "linux" && fs.existsSync(SANDBOX_PYTHON);

  it.skipIf(!canRunSqliteRestore)(
    "restores over a gateway-owned SQLite database the restoring user cannot write (#7312)",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-"));
      try {
        const dst = path.join(dir, "state.db");
        const makeDb = (file: string, table: string) =>
          spawnSync(SANDBOX_PYTHON, [
            "-c",
            `import sqlite3; c = sqlite3.connect(${JSON.stringify(file)}); c.execute("CREATE TABLE ${table}(x)"); c.commit(); c.close()`,
          ]);
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
});
