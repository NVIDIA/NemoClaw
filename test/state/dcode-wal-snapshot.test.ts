// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectExtractedDcodeSessionsDatabase } from "../../src/lib/state/snapshot/sqlite-credential-scan.js";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-snapshot-"));
process.env.HOME = TMP_HOME;

const sandboxState = await import("../../src/lib/state/sandbox.js");
beforeEach(() => {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "langchain-deepagents-code",
          model: "m",
          provider: "p",
          gpuEnabled: false,
        },
      },
    }),
  );
});

const QUICKJS_DIAGNOSTIC = "\0unexpected token: '%.*s'\0";
const ADJACENT_DIAGNOSTICS = QUICKJS_DIAGNOSTIC + QUICKJS_DIAGNOSTIC.slice(1);

function createConversationDatabase(content: string): { root: string; databasePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-diagnostic-"));
  const databasePath = path.join(root, ".deepagents/.state/sessions.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE checkpoints (thread_id TEXT, checkpoint BLOB)");
    database
      .prepare("INSERT INTO checkpoints VALUES (?, ?)")
      .run("019ab234-5678-7abc-8def-0123456789ab", Buffer.from(content));
  } finally {
    database.close();
  }
  return { root, databasePath };
}

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
  it("identifies a native conversation through the enforcing archive path", () => {
    const fixture = createConversationDatabase('password="private-test-value"');
    try {
      const before = fs.readFileSync(fixture.databasePath);
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: fixture.root,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success).toBe(false);
      expect(backup.manifest).toBeFalsy();
      expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
      expect(backup.error).not.toContain("private-test-value");
      expect(backup.error).toContain("rule: credential-assignment");
      expect(backup.error).toContain(
        "First affected conversation: 019ab234-5678-7abc-8def-0123456789ab",
      );
      expect(backup.error).toContain("#resolve-a-deep-agents-code-backup-refusal");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("distinguishes corrupt SQLite state from a credential finding", () => {
    const fixture = createConversationDatabase("ordinary conversation");
    try {
      fs.writeFileSync(fixture.databasePath, "private corrupt database content");
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: fixture.root,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success).toBe(false);
      expect(backup.manifest).toBeFalsy();
      expect(backup.error).toContain("SQLite inspection failed (sqlite-query)");
      expect(backup.error).toContain("Conversation identification unavailable");
      expect(backup.error).not.toContain("private corrupt");
      expect(backup.error).not.toContain("019ab234-5678-7abc-8def-0123456789ab");
      expect(fs.readFileSync(fixture.databasePath, "utf8")).toBe(
        "private corrupt database content",
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("distinguishes failed extraction without exposing its stderr", () => {
    const fixture = createConversationDatabase("ordinary conversation");
    const priorPath = process.env.PATH;
    try {
      const systemTar = spawnSync("which", ["tar"], { encoding: "utf8" }).stdout.trim();
      const bin = path.join(fixture.root, "test-bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "tar"),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.some(arg => arg.includes(".native-scan-"))) {
  process.stderr.write("private extraction error");
  process.exit(2);
}
const result = require("node:child_process").spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ""}`;
      const before = fs.readFileSync(fixture.databasePath);
      const backup = sandboxState.backupSandboxState("alpha", {
        nativeStateSource: {
          root: "/sandbox",
          directory: fixture.root,
          assertCurrent: () => undefined,
        },
      });
      expect(backup.success).toBe(false);
      expect(backup.manifest).toBeFalsy();
      expect(backup.error).toContain("Archive extraction failed");
      expect(backup.error).toContain("Conversation identification unavailable");
      expect(backup.error).not.toContain("private extraction");
      expect(backup.error).not.toContain("019ab234-5678-7abc-8def-0123456789ab");
      expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
    } finally {
      priorPath === undefined
        ? Reflect.deleteProperty(process.env, "PATH")
        : Reflect.set(process.env, "PATH", priorPath);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "categorizes extraction deadline expiry with deferred cleanup %s without exposing history",
    (deferCleanup) => {
      const fixture = createConversationDatabase("private-deadline-test-value");
      const priorPath = process.env.PATH;
      const marker = path.join(fixture.root, "deadline-marker");
      const start = Date.now();
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() => (fs.existsSync(marker) ? start + 60_001 : start));
      try {
        const systemTar = spawnSync("which", ["tar"], { encoding: "utf8" }).stdout.trim();
        const bin = path.join(fixture.root, "test-bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(
          path.join(bin, "tar"),
          `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.some(arg => arg.includes(".native-scan-"))) {
  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "expired");
}
const result = require("node:child_process").spawnSync(${JSON.stringify(systemTar)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
          { mode: 0o755 },
        );
        process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ""}`;
        const before = fs.readFileSync(fixture.databasePath);
        const backup = sandboxState.backupSandboxState("alpha", {
          deadlineMs: start + 60_000,
          deferSanitizationDeadlineCleanup: deferCleanup,
          nativeStateSource: {
            root: "/sandbox",
            directory: fixture.root,
            assertCurrent: () => undefined,
          },
        });
        expect(fs.existsSync(marker)).toBe(true);
        expect(backup.success).toBe(false);
        expect(Boolean(backup.manifest)).toBe(deferCleanup);
        expect(backup.manifest?.backupComplete).toBe(deferCleanup ? false : undefined);
        expect(backup.error).toContain("category: deadline-expiry");
        expect(backup.error).toContain("Conversation identification unavailable");
        expect(backup.error).toContain("#resolve-a-deep-agents-code-backup-refusal");
        expect(backup.error).not.toContain("private-deadline-test-value");
        expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
      } finally {
        clock.mockRestore();
        priorPath === undefined
          ? Reflect.deleteProperty(process.env, "PATH")
          : Reflect.set(process.env, "PATH", priorPath);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("does not guess a conversation from a raw WAL finding", () => {
    const { backup } = captureSidecar(
      ".deepagents/.state/sessions.db-wal",
      'password="private-test-value"',
    );
    expect(backup.success).toBe(false);
    expect(backup.error).toContain("credential-bearing content");
    expect(backup.error).toContain("Conversation identification unavailable");
    expect(backup.error).not.toContain("private-test-value");
  });

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

  it("rejects a bind marker without SQL context in the first chunk", () => {
    expectRejectedSidecar(".deepagents/.state/sessions.db-shm", "password=?\nordinary state");
  });

  it.each([
    ...["-journal", "-shm", "-wal", ".env"].map((suffix) => ({
      name: "credential-shaped text",
      suffix,
      content:
        "db.execute('UPDATE users SET name=? WHERE ((password=?))', (user, pw))" +
        (suffix === ".env"
          ? ""
          : `\n${suffix === "-shm" ? "password=opaque-value-for-snapshot" : `ghp_${"a".repeat(36)}`}`),
    })),
    {
      name: "a bind marker that becomes a credential in the next chunk",
      suffix: "-shm",
      content: "x".repeat(65_318) + "'SELECT " + " ".repeat(200) + "password=?private-value'",
    },
    {
      name: "a new assignment after normalized overlap fixtures",
      suffix: "-shm",
      content: "[STRIPPED_BY_MIGRATION]".repeat(3_000).slice(0, 65_536) + "\npassword=?",
    },
    {
      name: "a provider credential split across chunks",
      suffix: "-shm",
      content: "x".repeat(65_534) + `ghp_${"a".repeat(36)}`,
    },
  ])("rejects $name in sessions.db$suffix", ({ suffix, content }) => {
    expectRejectedSidecar(
      suffix === ".env" ? ".env" : `.deepagents/.state/sessions.db${suffix}`,
      content,
    );
  });

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
      expect(backup.error).toContain("category: deadline-expiry");
      expect(backup.error).toContain("Conversation identification unavailable");
      expect(backup.error).toContain("#resolve-a-deep-agents-code-backup-refusal");
      expect(backup.error).toContain(".deepagents/.state/sessions.db-wal");
      expect(fs.readdirSync(backupsRoot)).toEqual(before);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "ordinary conversation",
      4_096,
      'Example configuration: {"model":"not-a-secret-marker"}',
      Buffer.from("ordinary interpreter state"),
    ],
    [
      "the accepted QuickJS diagnostic",
      4_096,
      "ordinary conversation",
      Buffer.from(QUICKJS_DIAGNOSTIC),
    ],
    [
      "SQL conversation",
      4_096,
      [
        "db.execute('SELECT id FROM users WHERE name=? AND pass=?', (user, pw))",
        "db.execute('SELECT id FROM users WHERE password=?')",
        "db.execute('UPDATE users SET password=? WHERE id=?', (pw, user_id))",
        "db.execute('SELECT id FROM users WHERE (password = ?)', (pw,))",
        'db.execute("SELECT id FROM users WHERE ((password = ?))", (pw,))',
        "Do not use tools or execute SQL. Keep these examples as conversation context: " +
          "'SELECT id FROM users WHERE (password = ?)' and " +
          "'SELECT id FROM users WHERE ((password = ?))'. Reply with exactly one word: PONG",
      ].join("\n"),
    ],
    [
      "SQL near the chunk overlap",
      65_536,
      "'SELECT " + " ".repeat(200) + "password=?' " + "x".repeat(4_050),
    ],
  ] as const)(
    "preserves a live database and its %s",
    (_name, pageSize, content, payload = Buffer.from(ADJACENT_DIAGNOSTICS)) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wal-state-"));
      let database: DatabaseSync | null = null;
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, ".deepagents", ".state", "sessions.db");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        database = new DatabaseSync(databasePath);
        database.exec(
          `PRAGMA page_size = ${pageSize}; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;`,
        );
        database.exec("CREATE TABLE sessions (content TEXT)");
        database.prepare("INSERT INTO sessions VALUES (?)").run(content);
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
        const restored = new DatabaseSync(
          path.join(restoredRoot, ".deepagents/.state/sessions.db"),
          {
            readOnly: true,
          },
        );
        try {
          expect(
            Buffer.from(restored.prepare("SELECT value FROM writes").get()!.value as Uint8Array),
          ).toEqual(payload);
          expect(restored.prepare("SELECT content FROM sessions").all()).toEqual([{ content }]);
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
    },
  );
});
