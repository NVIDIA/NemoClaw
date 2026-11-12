// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inspectExtractedDcodeSessionsDatabase } from "../../src/lib/state/snapshot/sqlite-credential-scan.js";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-snapshot-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import("../../src/lib/state/sandbox.js");
const QUICKJS_DIAGNOSTIC = "\0unexpected token: '%.*s'\0";
const ADJACENT_DIAGNOSTICS = QUICKJS_DIAGNOSTIC + QUICKJS_DIAGNOSTIC.slice(1);

function captureSidecar(entry: string, content: string) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-sidecar-"));
  const backupsRoot = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups", "alpha");
  const before = fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : [];
  try {
    const nativeRoot = path.join(fixture, "native-home");
    const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE sessions (content TEXT)");
    database.close();
    fs.writeFileSync(path.join(nativeRoot, entry), content);

    const backup = sandboxState.backupSandboxState("alpha", {
      nativeStateSource: {
        root: "/sandbox",
        directory: nativeRoot,
        assertCurrent: () => undefined,
      },
    });

    expect(fs.readFileSync(path.join(nativeRoot, entry), "utf8")).toBe(content);
    return { backup, before, after: fs.readdirSync(backupsRoot) };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function expectAcceptedSidecar(entry: string, content: string): void {
  const { backup } = captureSidecar(entry, content);
  expect(backup.success, backup.error).toBe(true);
}

function expectRejectedSidecar(entry: string, content: string): void {
  const { backup, before, after } = captureSidecar(entry, content);
  expect(backup.success).toBe(false);
  expect(backup.error).toContain(entry);
  expect(after).toEqual(before);
}

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("DCode WAL snapshot persistence", () => {
  it.each(["-journal", "-shm", "-wal"])(
    "accepts only the complete diagnostic in a sessions.db%s sidecar",
    (suffix) =>
      expectAcceptedSidecar(`.deepagents/.state/sessions.db${suffix}`, QUICKJS_DIAGNOSTIC),
  );

  it.each(["-journal", "-shm", "-wal"])(
    "accepts diagnostics sharing a NUL delimiter in a sessions.db%s sidecar",
    (suffix) =>
      expectAcceptedSidecar(`.deepagents/.state/sessions.db${suffix}`, ADJACENT_DIAGNOSTICS),
  );

  it.each(Array.from({ length: ADJACENT_DIAGNOSTICS.length - 1 }, (_, index) => index + 1))(
    "preserves adjacent diagnostics split after byte %i at the scan boundary",
    (split) =>
      expectAcceptedSidecar(
        ".deepagents/.state/sessions.db-wal",
        "\0".repeat(64 * 1024 - split) + ADJACENT_DIAGNOSTICS,
      ),
  );

  it.each(Array.from({ length: QUICKJS_DIAGNOSTIC.length - 1 }, (_, index) => index + 1))(
    "preserves a sidecar diagnostic split after byte %i at the scan boundary",
    (split) =>
      expectAcceptedSidecar(
        ".deepagents/.state/sessions.db-wal",
        "\0".repeat(64 * 1024 - split) + QUICKJS_DIAGNOSTIC + "\0ordinary state",
      ),
  );

  it("preserves a diagnostic when the scan overlap starts inside it", () => {
    expectAcceptedSidecar(
      ".deepagents/.state/sessions.db-wal",
      "\0".repeat(60 * 1024 - 1) + QUICKJS_DIAGNOSTIC + "\0".repeat(8 * 1024),
    );
  });

  it.each([
    ["changed value", "\0unexpected token: 'private-value'\0"],
    ["changed format", "\0unexpected token: '%s'\0"],
    [
      "changed value after a chunk split",
      "\0".repeat(64 * 1024 - 20) + "\0unexpected token: '%.*secret'\0",
    ],
    ["missing leading delimiter", "unexpected token: '%.*s'\0"],
    ["missing trailing delimiter", "\0unexpected token: '%.*s'"],
    ["incomplete diagnostic at EOF", "\0".repeat(64 * 1024 - 22) + "\0unexpected token: '%.*s'"],
    ["adjacent provider credential", QUICKJS_DIAGNOSTIC + `ghp_${"a".repeat(36)}`],
    ["adjacent opaque credential", QUICKJS_DIAGNOSTIC + '\0password="private-value"'],
    ["credential after shared delimiters", ADJACENT_DIAGNOSTICS + 'password="private-value"'],
    ["changed diagnostic sharing a delimiter", QUICKJS_DIAGNOSTIC + "unexpected token: '%s'\0"],
    [
      "credential before a split diagnostic",
      `password="private-value"\0` + "\0".repeat(64 * 1024 - 30) + QUICKJS_DIAGNOSTIC,
    ],
    [
      "credential after a split diagnostic",
      "\0".repeat(64 * 1024 - 20) + QUICKJS_DIAGNOSTIC + '\0password="private-value"',
    ],
    ["private key header", QUICKJS_DIAGNOSTIC + ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
  ])("rejects %s in sidecar bytes outside logical database rows", (_label, content) => {
    expectRejectedSidecar(".deepagents/.state/sessions.db-wal", content);
  });

  it("keeps the diagnostic exception out of environment files", () => {
    expectRejectedSidecar(".env", QUICKJS_DIAGNOSTIC);
  });

  it.each([
    ["superseded", "COMMIT; DELETE FROM writes WHERE rowid=2"],
    ["uncommitted", ""],
  ])(
    "rejects credential bytes in %s WAL frames beside the accepted diagnostic",
    (_state, finishTransaction) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-hidden-wal-"));
      let database: DatabaseSync | undefined;
      const entry = ".deepagents/.state/sessions.db";
      const credential = `ghp_${"b".repeat(36)}`;
      try {
        fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
        database = new DatabaseSync(path.join(root, entry));
        database.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=1; CREATE TABLE writes (value BLOB)",
        );
        database.prepare("INSERT INTO writes VALUES (?)").run(Buffer.from(QUICKJS_DIAGNOSTIC));
        database.exec("BEGIN");
        database
          .prepare("INSERT INTO writes VALUES (?)")
          .run(
            Buffer.concat([
              Buffer.alloc(64 * 1024),
              Buffer.from(QUICKJS_DIAGNOSTIC + credential),
              Buffer.alloc(256 * 1024),
            ]),
          );
        database.exec(finishTransaction);
        expect(
          fs.readFileSync(path.join(root, `${entry}-wal`)).includes(Buffer.from(credential)),
        ).toBe(true);
        expect(inspectExtractedDcodeSessionsDatabase(root, entry)).toBe(false);

        const backup = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: { root: "/sandbox", directory: root, assertCurrent: () => undefined },
        });
        expect(backup.success).toBe(false);
        expect(backup.error).toContain(`${entry}-wal`);
      } finally {
        database?.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["-journal", "-shm", "-wal"])(
    "rejects credential bytes in a sessions.db%s sidecar",
    (suffix) =>
      expectRejectedSidecar(
        `.deepagents/.state/sessions.db${suffix}`,
        suffix === "-shm" ? "password=opaque-value-for-snapshot" : `ghp_${"a".repeat(36)}`,
      ),
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

  it.each([
    ["ordinary interpreter state", Buffer.from("ordinary interpreter state")],
    ["the accepted QuickJS diagnostic", Buffer.from("\0unexpected token: '%.*s'\0")],
    ["adjacent QuickJS diagnostics sharing a NUL delimiter", Buffer.from(ADJACENT_DIAGNOSTICS)],
  ])("preserves %s from an active WAL through archive readback", (_label, payload) => {
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
      database.exec("CREATE TABLE writes (value BLOB)");
      database.prepare("INSERT INTO writes VALUES (?)").run(payload);
      expect(fs.readFileSync(`${databasePath}-wal`).includes(payload)).toBe(true);
      fs.mkdirSync(path.join(nativeRoot, "workspace"));
      fs.writeFileSync(path.join(nativeRoot, "workspace", "marker"), "preserved workspace");

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
      const restoredRoot = path.join(fixture, "restored");
      fs.mkdirSync(restoredRoot);
      const extraction = spawnSync("tar", [
        "-xf",
        path.join(backup.manifest!.backupPath, "native-home.tar"),
        "-C",
        restoredRoot,
      ]);
      expect(extraction.status, extraction.stderr.toString()).toBe(0);
      const restored = new DatabaseSync(path.join(restoredRoot, ".deepagents/.state/sessions.db"), {
        readOnly: true,
      });
      try {
        expect(
          Buffer.from(restored.prepare("SELECT value FROM writes").get()!.value as Uint8Array),
        ).toEqual(payload);
        expect(restored.prepare("SELECT content FROM sessions").get()!.content).toBe(
          'Example configuration: {"model":"not-a-secret-marker"}',
        );
      } finally {
        restored.close();
      }
      expect(fs.readFileSync(path.join(restoredRoot, "workspace", "marker"), "utf8")).toBe(
        "preserved workspace",
      );
    } finally {
      database?.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
