// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-snapshot-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import("../../src/lib/state/sandbox.js");

afterEach(() => {
  fs.rmSync(path.join(TMP_HOME, ".nemoclaw", "rebuild-backups"), {
    recursive: true,
    force: true,
  });
});

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function withLiveDatabaseBackup(
  content: string | Buffer,
  inspectBackup: (backup: ReturnType<typeof sandboxState.backupSandboxState>) => void,
): void {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-state-"));
  let database: DatabaseSync | null = null;
  try {
    const nativeRoot = path.join(fixture, "native-home");
    const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    database.exec("CREATE TABLE sessions (content BLOB)");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.prepare("INSERT INTO sessions VALUES (?)").run(content);
    expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);
    const payload = Buffer.from(content);
    expect(fs.readFileSync(databasePath).includes(payload)).toBe(false);
    expect(fs.readFileSync(`${databasePath}-wal`).includes(payload)).toBe(true);

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
            agent: "langchain-deepagents-code",
          },
        },
      }),
    );

    const original = database.prepare("SELECT content FROM sessions").get();
    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });

    inspectBackup(backup);
    expect(database.prepare("SELECT content FROM sessions").get()).toEqual(original);
  } finally {
    database?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe("DCode WAL snapshot persistence", () => {
  it.each([
    {
      title: "preserves ordinary session text in a live database and WAL",
      content: 'Example configuration: {"model":"not-a-secret-marker"}',
    },
    {
      title: "preserves a WAL checkpoint with the pinned QuickJS diagnostic",
      content: Buffer.from("\0unexpected token: '%.*s'\0"),
    },
  ])("$title", ({ content }) => {
    withLiveDatabaseBackup(content, (backup) => {
      expect(backup.success, backup.error).toBe(true);
      const archived = spawnSync("tar", [
        "-tf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
      ]);
      expect(archived.status, archived.stderr.toString()).toBe(0);
      expect(archived.stdout.toString()).toContain(".deepagents/.state/sessions.db");
      expect(archived.stdout.toString()).toContain(".deepagents/.state/sessions.db-wal");
    });
  });

  it("rejects publication when a WAL checkpoint contains an adjacent credential", () => {
    const content = Buffer.from(`\0unexpected token: '%.*s'\0ghp_${"0123456789abcdef"}`);
    withLiveDatabaseBackup(content, (backup) => {
      expect(backup.success).toBe(false);
      expect(backup.manifest).toBeUndefined();
      expect(backup.error).toContain("credential-bearing or uninspectable content");
      expect(backup.error).toContain(".deepagents/.state/sessions.db");
      const backups = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups", "alpha");
      expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
    });
  });
});
