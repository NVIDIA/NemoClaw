// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wal-snapshot-home-"));
process.env.HOME = testHome;
const sandboxState = await import(
  pathToFileURL(path.join(import.meta.dirname, "../..", "src", "lib", "state", "sandbox.ts")).href
);
const backupsRoot = path.join(testHome, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", originalHome);
  fs.rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(backupsRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(testHome, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(testHome, ".nemoclaw", "sandboxes.json"),
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
});

describe("complete native OpenClaw WAL persistence", () => {
  it.each([".openclaw", ".openclaw-data"])(
    "retains committed %s WAL state through a private standalone database copy",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-wal-state-"));
      let liveDatabase: DatabaseSync | null = null;
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        liveDatabase = new DatabaseSync(databasePath);
        liveDatabase.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE device_identities (identity_key TEXT PRIMARY KEY, private_key_pem TEXT);
          CREATE TABLE session_state (session_id TEXT PRIMARY KEY, summary TEXT);
          INSERT INTO device_identities VALUES ('primary', 'machine-local-authority');
          INSERT INTO session_state VALUES ('session-in-wal', 'retain committed conversation');
        `);
        expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: vi.fn(),
          },
        });

        expect(backup.success, backup.error).toBe(true);
        const archivePath = path.join(backup.manifest!.backupPath, "native-home.tar");
        const archivedPaths = spawnSync("tar", ["-tf", archivePath]).stdout.toString();
        expect(archivedPaths).toContain(`${stateDirectory}/state/openclaw.sqlite`);
        expect(archivedPaths).not.toContain(`${stateDirectory}/state/openclaw.sqlite-wal`);
        expect(archivedPaths).not.toContain(`${stateDirectory}/state/openclaw.sqlite-shm`);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            const archived = new DatabaseSync(
              path.join(root, stateDirectory, "state", "openclaw.sqlite"),
              { readOnly: true },
            );
            try {
              expect(archived.prepare("SELECT * FROM session_state").get()).toEqual({
                session_id: "session-in-wal",
                summary: "retain committed conversation",
              });
              expect(
                archived.prepare("SELECT COUNT(*) AS count FROM device_identities").get(),
              ).toEqual({ count: 0 });
            } finally {
              archived.close();
            }
          },
          `${stateDirectory}/state`,
        );
        expect(
          liveDatabase.prepare("SELECT COUNT(*) AS count FROM device_identities").get(),
        ).toEqual({ count: 1 });
      } finally {
        liveDatabase?.close();
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
