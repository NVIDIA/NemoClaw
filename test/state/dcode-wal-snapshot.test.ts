// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-snapshot-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import("../../src/lib/state/sandbox.js");

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("DCode WAL snapshot persistence", () => {
  it.each(["-journal", "-shm", "-wal"])(
    "rejects credential bytes in a sessions.db%s sidecar",
    (suffix) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-sidecar-secret-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE sessions (content TEXT)");
        database.close();
        const credential =
          suffix === "-shm"
            ? ["password=", "opaque-value-for-snapshot"].join("")
            : ["ghp_", "a".repeat(36)].join("");
        fs.writeFileSync(`${databasePath}${suffix}`, credential);

        fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
        fs.writeFileSync(
          path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
          JSON.stringify({
            defaultSandbox: "alpha",
            sandboxes: {
              alpha: {
                name: "alpha",
                model: "m",
                provider: "p",
                gpuEnabled: false,
                agent: null,
              },
            },
          }),
        );

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: () => undefined,
          },
        });

        expect(backup.success).toBe(false);
        expect(backup.error).toContain(`.deepagents/.state/sessions.db${suffix}`);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("stops a sidecar scan at the deadline and removes the unpublished backup", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-sidecar-deadline-"));
    const backupsRoot = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups", "alpha");
    const before = fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : [];
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE sessions (content TEXT)");
      database.close();
      fs.writeFileSync(`${databasePath}-wal`, Buffer.alloc(4 * 1024 * 1024));

      const start = Date.now();
      let now = start;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 100));
      let backup: ReturnType<typeof sandboxState.backupSandboxState>;
      try {
        backup = sandboxState.backupSandboxState("alpha", {
          deadlineMs: start + 2_000,
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: () => undefined,
          },
        });
      } finally {
        clock.mockRestore();
      }

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("credential scan exceeded the backup deadline");
      expect(backup.error).toContain(".deepagents/.state/sessions.db-wal");
      expect(fs.readdirSync(backupsRoot)).toEqual(before);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("validates and preserves a live database as one SQLite state family", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-state-"));
    let database: DatabaseSync | null = null;
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      database = new DatabaseSync(databasePath);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      database.exec("CREATE TABLE sessions (content TEXT)");
      database
        .prepare("INSERT INTO sessions VALUES (?)")
        .run('Example configuration: {"model":"not-a-secret-marker"}');
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

      fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
      fs.writeFileSync(
        path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "alpha",
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "m",
              provider: "p",
              gpuEnabled: false,
              agent: null,
            },
          },
        }),
      );

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: nativeRoot,
          assertCurrent: () => undefined,
        },
      });

      expect(backup.success, backup.error).toBe(true);
      const archivedPaths = spawnSync("tar", [
        "-tf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
      ]).stdout.toString();
      expect(archivedPaths).toContain(".deepagents/.state/sessions.db");
      expect(archivedPaths).toContain(".deepagents/.state/sessions.db-wal");
    } finally {
      database?.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
