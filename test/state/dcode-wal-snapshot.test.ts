// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

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
