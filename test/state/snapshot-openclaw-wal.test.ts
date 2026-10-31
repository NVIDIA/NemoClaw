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
const migrationRunId = (hash: string): string => `legacy-main-session-keys:${hash}`;
const OPENCLAW_MIGRATION_RUN_ID = migrationRunId("2f973b4e85afb0c7a5f9bd15");
const SYNTHETIC_MIGRATION_RUN_ID = migrationRunId("0123456789abcdef01234567");

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
    "backs up %s after OpenClaw writes its machine-local config fingerprint cache",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-config-cache-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec(`
          CREATE TABLE diagnostic_events (
            scope TEXT NOT NULL,
            event_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            sequence INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, event_key)
          ) STRICT;
        `);
        const insert = database.prepare("INSERT INTO diagnostic_events VALUES (?, ?, ?, 1, 0)");
        insert.run(
          "config-snapshot",
          "latest",
          JSON.stringify({
            configPath: "/sandbox/.openclaw/openclaw.json",
            rawHash: "a".repeat(64),
            fingerprintedAuthoredConfig: {
              gateway: { auth: { token: "fp:0123456789ab" } },
              models: { providers: { inference: { apiKey: "fp:abcdef012345" } } },
            },
          }),
        );
        const retained = '{"event":"agent.completed","message":"PONG"}';
        insert.run("config-audit", "latest", retained);
        insert.run("config-snapshot", "previous", retained);
        database.close();
        const before = fs.readFileSync(databasePath);

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        });

        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            const archived = new DatabaseSync(
              path.join(root, stateDirectory, "state", "openclaw.sqlite"),
              { readOnly: true },
            );
            try {
              expect(
                archived
                  .prepare(
                    "SELECT scope, event_key, payload_json FROM diagnostic_events ORDER BY scope, event_key",
                  )
                  .all(),
              ).toEqual([
                { scope: "config-audit", event_key: "latest", payload_json: retained },
                { scope: "config-snapshot", event_key: "previous", payload_json: retained },
              ]);
            } finally {
              archived.close();
            }
          },
          `${stateDirectory}/state`,
        );
        expect(fs.readFileSync(databasePath)).toEqual(before);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["config-audit", "latest"],
    ["config-snapshot", "previous"],
  ])("rejects credentials in the retained diagnostic row %s/%s", (scope, eventKey) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-audit-denial-"));
    try {
      const nativeRoot = path.join(fixture, "native-home");
      const databasePath = path.join(nativeRoot, ".openclaw", "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(
        "CREATE TABLE diagnostic_events (scope TEXT, event_key TEXT, payload_json TEXT)",
      );
      database
        .prepare("INSERT INTO diagnostic_events VALUES (?, ?, ?)")
        .run(scope, eventKey, '{"apiKey":"private-example-value"}');
      database.close();
      const before = fs.readFileSync(databasePath);

      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
      });

      expect(backup.success).toBe(false);
      expect(backup.error).toContain("credential-bearing or uninspectable content");
      expect(fs.readFileSync(databasePath)).toEqual(before);
      const sandboxBackups = path.join(backupsRoot, "alpha");
      expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([".openclaw", ".openclaw-data"])(
    "backs up %s migration ledger IDs generated by OpenClaw 2026.9.2",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-migration-state-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec(`
          CREATE TABLE migration_runs (id TEXT PRIMARY KEY, report_json TEXT);
          CREATE TABLE migration_sources (source_key TEXT PRIMARY KEY, last_run_id TEXT);
        `);
        const runId = OPENCLAW_MIGRATION_RUN_ID;
        database
          .prepare("INSERT INTO migration_runs VALUES (?, ?)")
          .run(runId, '{"status":"completed"}');
        database
          .prepare("INSERT INTO migration_sources VALUES (?, ?)")
          .run("legacy-main-session-keys", runId);
        database.close();
        const before = fs.readFileSync(databasePath);

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
        });

        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            const archived = new DatabaseSync(
              path.join(root, stateDirectory, "state", "openclaw.sqlite"),
              { readOnly: true },
            );
            try {
              expect(archived.prepare("SELECT id FROM migration_runs").get()).toEqual({
                id: runId,
              });
              expect(archived.prepare("SELECT last_run_id FROM migration_sources").get()).toEqual({
                last_run_id: runId,
              });
            } finally {
              archived.close();
            }
          },
          `${stateDirectory}/state`,
        );
        expect(fs.readFileSync(databasePath)).toEqual(before);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each([".openclaw", ".openclaw-data"])(
    "backs up benign %s SQLite cells without treating record framing as a credential",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-record-state-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec("CREATE TABLE session_state (prefix TEXT, summary TEXT)");
        database
          .prepare("INSERT INTO session_state VALUES (?, ?)")
          .run("ghp_", "benign-session-context-retained");
        database.close();

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: {
            root: "/sandbox",
            directory: nativeRoot,
            assertCurrent: vi.fn(),
          },
        });

        expect(backup.success, backup.error).toBe(true);
        sandboxState.inspectNativeSandboxState(
          backup.manifest!.backupPath,
          (root: string) => {
            const archived = new DatabaseSync(
              path.join(root, stateDirectory, "state", "openclaw.sqlite"),
              { readOnly: true },
            );
            try {
              expect(archived.prepare("SELECT * FROM session_state").get()).toEqual({
                prefix: "ghp_",
                summary: "benign-session-context-retained",
              });
            } finally {
              archived.close();
            }
          },
          `${stateDirectory}/state`,
        );
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  describe.each([".openclaw", ".openclaw-data"])(
    "%s database credential boundary",
    (stateDirectory) => {
      it.each([
        ["credential in an ID", "migration_runs", "id", `ghp_${"0123456789abcdef"}`, "ordinary"],
        [
          "short migration hash",
          "migration_runs",
          "id",
          migrationRunId("0123456789abcdef0123456"),
          "ordinary",
        ],
        [
          "credential appended to a migration ID",
          "migration_sources",
          "last_run_id",
          `${SYNTHETIC_MIGRATION_RUN_ID} ghp_${"0123456789abcdef"}`,
          "ordinary",
        ],
        ["migration ID in another table", "history", "id", SYNTHETIC_MIGRATION_RUN_ID, "ordinary"],
        [
          "migration ID in another column",
          "migration_runs",
          "report_json",
          SYNTHETIC_MIGRATION_RUN_ID,
          "ordinary",
        ],
        [
          "migration ID in a BLOB",
          "migration_runs",
          "id",
          Buffer.from(SYNTHETIC_MIGRATION_RUN_ID),
          "ordinary",
        ],
        [
          "credential beside a valid ID",
          "migration_runs",
          "id",
          SYNTHETIC_MIGRATION_RUN_ID,
          '{"API_KEY":"private-example-value"}',
        ],
      ])("rejects %s in migration metadata", (_label, tableName, columnName, value, context) => {
        const fixture = fs.mkdtempSync(
          path.join(os.tmpdir(), "nemoclaw-openclaw-migration-denial-"),
        );
        try {
          const nativeRoot = path.join(fixture, "native-home");
          const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
          fs.mkdirSync(path.dirname(databasePath), { recursive: true });
          const database = new DatabaseSync(databasePath);
          database.exec(`CREATE TABLE ${tableName} (${columnName}, context TEXT)`);
          database.prepare(`INSERT INTO ${tableName} VALUES (?, ?)`).run(value, context);
          database.close();
          const before = fs.readFileSync(databasePath);

          const backup = sandboxState.backupSandboxState("alpha", {
            nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
          });

          expect(backup.success).toBe(false);
          expect(backup.error).toContain("credential-bearing or uninspectable content");
          expect(fs.readFileSync(databasePath)).toEqual(before);
          const sandboxBackups = path.join(backupsRoot, "alpha");
          expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      });

      it("rejects credentials stored only in a view definition", () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-schema-state-"));
        try {
          const nativeRoot = path.join(fixture, "native-home");
          const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
          fs.mkdirSync(path.dirname(databasePath), { recursive: true });
          const database = new DatabaseSync(databasePath);
          database.exec(`CREATE VIEW cached_secret AS SELECT 'ghp_${"0123456789abcdef"}' AS value`);
          database.close();
          const backup = sandboxState.backupSandboxState("alpha", {
            nativeStateSource: { root: "/sandbox", directory: nativeRoot, assertCurrent: vi.fn() },
          });
          expect(backup.success).toBe(false);
          expect(backup.error).toContain("credential-bearing or uninspectable content");
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      });

      it.each([
        ["text credential", `ghp_${"0123456789abcdef"}`],
        ["JSON credential", '{"API_KEY":"private-example-value"}'],
        ["BLOB credential", Buffer.from(`ghp_${"fedcba9876543210"}`)],
        ["DCode-only diagnostic", Buffer.from("\0unexpected token: '%.*s'\0")],
      ])(
        "rejects a %s without publishing a backup or changing the live source",
        (_label, value) => {
          const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-secret-state-"));
          try {
            const nativeRoot = path.join(fixture, "native-home");
            const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
            const database = new DatabaseSync(databasePath);
            database.exec("CREATE TABLE session_state (content)");
            database.prepare("INSERT INTO session_state VALUES (?)").run(value);
            database.close();
            const before = fs.readFileSync(databasePath);

            const backup = sandboxState.backupSandboxState("alpha", {
              nativeStateSource: {
                root: "/sandbox",
                directory: nativeRoot,
                assertCurrent: vi.fn(),
              },
            });

            expect(backup.success).toBe(false);
            expect(backup.error).toContain("credential-bearing or uninspectable content");
            expect(backup.error).toContain(`${stateDirectory}/state/openclaw.sqlite`);
            expect(fs.readFileSync(databasePath)).toEqual(before);
            const sandboxBackups = path.join(backupsRoot, "alpha");
            expect(fs.existsSync(sandboxBackups) ? fs.readdirSync(sandboxBackups) : []).toEqual([]);
          } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
          }
        },
      );
    },
  );

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
