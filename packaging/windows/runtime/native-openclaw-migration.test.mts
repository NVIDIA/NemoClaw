// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureMigrationHistory,
  verifyMigrationHistory,
} from "./native-openclaw-migration-verification.mts";
import {
  inspectLegacyOpenClawSessions,
  migrateNativeOpenClawSessions,
} from "./native-openclaw-migration.mts";

// Match the pinned OpenClaw doctor's report and archive layout, not a private test format.
function migrationApp(
  beforeImport = "",
  importAction = "fs.renameSync(store, archive);",
  alterReport = "",
) {
  return `exports.runOpenClaw = async argv => {
    const fs = require('node:fs'); const path = require('node:path');
    const mode = argv[4]; const store = argv[6];
    const archiveDir = path.join(path.dirname(path.dirname(store)), 'session-sqlite-import-archive');
    const archive = path.join(archiveDir, 'legacy-store.sessions.json.imported-123456');
    const sqlite = path.join(path.dirname(path.dirname(store)), 'agent', 'openclaw-agent.sqlite');
    const transcript = path.join(path.dirname(store), 'session-1.jsonl');
    const transcriptArchive = path.join(archiveDir, 'main.session-1.jsonl.imported-123456');
    ${beforeImport}
    if (mode === 'import') {
      fs.mkdirSync(archiveDir, {recursive:true});
      ${importAction}
      const {DatabaseSync} = require('node:sqlite');
      fs.mkdirSync(path.dirname(sqlite), {recursive:true});
      const db = new DatabaseSync(sqlite);
      try {
        db.exec('CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, entry_valid INTEGER); CREATE TABLE transcript_events(session_id TEXT, event_json TEXT);');
        db.prepare('INSERT INTO session_nodes VALUES (?,?,1)').run('main','session-1');
        for (const line of fs.readFileSync(transcript,'utf8').trim().split('\\n'))
          if (line && JSON.parse(line)) db.prepare('INSERT INTO transcript_events VALUES (?,?)').run('session-1',line);
      } finally { db.close(); }
      fs.renameSync(transcript, transcriptArchive);
    }
    const report = {mode, targets:[{agentId:'main', storePath:store,
      archivedLegacyStoreFiles:mode === 'import' ? [archive] : []}],
      totals:{issues:0,targets:1,archivedLegacyStoreFiles:mode === 'import' ? 1 : 0}};
    if (mode === 'import') { ${alterReport} }
    console.log(JSON.stringify(report));
    throw Object.assign(new Error('done'),{name:'ExitError',code:0});
  };`;
}

for (const [name, corrupt] of [
  ["missing transcript archive", "fs.unlinkSync(transcriptArchive);"],
  ["changed transcript archive", "fs.writeFileSync(transcriptArchive, 'changed');"],
  [
    "hard-linked transcript archive",
    "fs.linkSync(transcriptArchive, transcriptArchive + '.link');",
  ],
  [
    "redirected transcript archive",
    "fs.renameSync(transcriptArchive, transcriptArchive + '.target'); fs.symlinkSync(transcriptArchive + '.target', transcriptArchive);",
  ],
  ["missing database", "fs.unlinkSync(sqlite);"],
  ["corrupt database", "fs.writeFileSync(sqlite, 'invalid database');"],
  ["missing session", "db.exec('DELETE FROM session_nodes');"],
  ["wrong session identity", "db.exec(\"UPDATE session_nodes SET current_session_id='other'\");"],
  ["invalid session entry", "db.exec('UPDATE session_nodes SET entry_valid=0');"],
  ["missing transcript events", "db.exec('DELETE FROM transcript_events');"],
]) {
  test(`migration rejects reported success with ${name} and keeps retry blocked`, async (t) => {
    const mutation = corrupt.startsWith("db.")
      ? `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(sqlite); try { ${corrupt} } finally { db.close(); }`
      : corrupt;
    const f = await fixture(t, migrationApp("", "fs.renameSync(store, archive);", mutation));
    const original = fs.readFileSync(f.store);
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
    assert.deepEqual(fs.readFileSync(f.archive), original);
    assert.equal(fs.existsSync(f.pending), true);
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  });
}

async function fixture(t: test.TestContext, source?: string, compileWorker = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-migration-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const sessions = path.join(home, ".openclaw", "agents", "main", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, "session-1.jsonl");
  fs.writeFileSync(transcript, '{"message":"retained"}\n');
  const store = path.join(sessions, "sessions.json");
  fs.writeFileSync(
    store,
    JSON.stringify({ main: { sessionId: "session-1", sessionFile: transcript } }),
  );
  const runtimeRoot = path.join(root, "runtime");
  const workers = path.join(runtimeRoot, "workers");
  fs.mkdirSync(workers, { recursive: true });
  if (compileWorker || source !== undefined) {
    const { build } = await import("esbuild");
    await build({
      entryPoints: [
        fileURLToPath(new URL("./native-openclaw-migration-worker.mts", import.meta.url)),
      ],
      outfile: path.join(workers, "openclaw-migrate.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
    });
  }
  fs.writeFileSync(path.join(workers, "openclaw-migration-config.json"), "{}");
  const entry = path.join(runtimeRoot, "app.cjs");
  fs.writeFileSync(entry, source ?? migrationApp());
  return {
    root,
    home,
    sessions,
    transcript,
    store,
    pending: path.join(home, ".openclaw", ".nemoclaw-history-migration-pending"),
    archive: path.join(
      path.dirname(sessions),
      "session-sqlite-import-archive",
      "legacy-store.sessions.json.imported-123456",
    ),
    runtimeRoot,
    entry,
    node: process.execPath,
    assertHeld() {},
  };
}

test("migration runs dry-run and import, preserves originals, and skips migrated state", async (t) => {
  const f = await fixture(t, undefined, true);
  const original = fs.readFileSync(f.store);
  assert.equal(await migrateNativeOpenClawSessions(f), true);
  assert.deepEqual(fs.readFileSync(f.archive), original);
  assert.equal(fs.existsSync(f.pending), false);
  assert.equal(await migrateNativeOpenClawSessions(f), false);
});

test("migration verification permits an empty archived index without creating SQLite", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.store, "{}");
  fs.unlinkSync(f.transcript);
  const history = captureMigrationHistory(f.store);
  fs.mkdirSync(path.dirname(f.archive));
  fs.renameSync(f.store, f.archive);
  verifyMigrationHistory(history);
  assert.equal(fs.existsSync(path.join(path.dirname(f.sessions), "agent")), false);
});

test("migration accepts retained database events in addition to the imported transcript", async (t) => {
  const f = await fixture(
    t,
    migrationApp(
      "",
      "fs.renameSync(store, archive);",
      `
    const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync(sqlite);
    try { db.prepare('INSERT INTO transcript_events VALUES (?,?)').run('session-1', '{"retained":true}'); }
    finally { db.close(); }
  `,
    ),
  );
  assert.equal(await migrateNativeOpenClawSessions(f), true);
  assert.equal(fs.existsSync(f.pending), false);
});

test("migration capture counts shared transcripts once and ignores unrelated trajectory pointers", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    f.store,
    JSON.stringify({
      main: { sessionId: "session-1" },
      alias: { sessionId: "session-1", sessionFile: f.transcript },
    }),
  );
  const text = `${JSON.stringify({ message: "日本語".repeat(30_000) })}\nfalse\n\n${JSON.stringify({ message: "tail" })}`;
  fs.writeFileSync(f.transcript, text);
  fs.writeFileSync(path.join(f.sessions, "unrelated.trajectory-path.json"), "orphan pointer");
  const history = captureMigrationHistory(f.store);
  assert.equal(history.originals.size, 1);
  assert.deepEqual(history.sessions, [
    { key: "main", id: "session-1", events: 2 },
    { key: "alias", id: "session-1", events: 2 },
  ]);
});

for (const [name, action, reportChange] of [
  ["deleted source without an archive", "fs.unlinkSync(store);", ""],
  [
    "changed archive content",
    "fs.renameSync(store, archive); fs.writeFileSync(archive, '{}');",
    "",
  ],
  ["missing archive receipt", "fs.renameSync(store, archive);", "delete report.targets;"],
  [
    "wrong store receipt",
    "fs.renameSync(store, archive);",
    "report.targets[0].storePath += '.other';",
  ],
  ["wrong agent receipt", "fs.renameSync(store, archive);", "report.targets[0].agentId = 'other';"],
  [
    "inconsistent archive count",
    "fs.renameSync(store, archive);",
    "report.totals.archivedLegacyStoreFiles = 0;",
  ],
  [
    "outside archive path",
    "fs.renameSync(store, archive);",
    "report.targets[0].archivedLegacyStoreFiles = [store + '.outside'];",
  ],
  [
    "hard-linked archive",
    "fs.renameSync(store, archive); fs.linkSync(archive, archive + '.link');",
    "",
  ],
  [
    "redirected archive directory",
    `fs.rmdirSync(archiveDir);
    const other = path.join(path.dirname(archiveDir), 'redirected-archive'); fs.mkdirSync(other);
    fs.symlinkSync(other, archiveDir, process.platform === 'win32' ? 'junction' : 'dir');
    fs.renameSync(store, archive);`,
    "",
  ],
]) {
  test(`migration rejects ${name} instead of reporting successful preservation`, async (t) => {
    const f = await fixture(t, migrationApp("", action, reportChange));
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
    // An absent legacy index after a failed import must not make the next launch
    // treat unverified history as an already-completed migration.
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  });
}

test("failed import retains original history and blocks a silent retry after index archival", async (t) => {
  const f = await fixture(
    t,
    migrationApp(
      "",
      `fs.renameSync(store, archive);
      throw Object.assign(new Error('interrupted'), {name:'ExitError',code:2});`,
    ),
  );
  const original = fs.readFileSync(f.store);
  const transcript = fs.readFileSync(f.transcript);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert.equal(fs.existsSync(f.store), false);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert.deepEqual(fs.readFileSync(f.archive), original);
  assert.deepEqual(fs.readFileSync(f.transcript), transcript);
});

for (const kind of ["file", "directory", "dangling link", "hard link"] as const) {
  test(`migration refuses an existing pending ${kind} even without a legacy index`, async (t) => {
    const f = await fixture(t);
    const other = path.join(f.root, "pending-target");
    if (kind === "file") fs.writeFileSync(f.pending, "incomplete");
    if (kind === "directory") fs.mkdirSync(f.pending);
    if (kind === "dangling link") fs.symlinkSync(other, f.pending);
    if (kind === "hard link") {
      fs.writeFileSync(other, "do not modify");
      fs.linkSync(other, f.pending);
    }
    fs.unlinkSync(f.store);
    const original = fs.lstatSync(f.pending);
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
    assert.equal(fs.lstatSync(f.pending).ino, original.ino);
    if (kind === "hard link") assert.equal(fs.readFileSync(other, "utf8"), "do not modify");
    if (kind === "dangling link") assert.equal(fs.existsSync(other), false);
  });
}

test("migration keeps incomplete state when the lease is lost after import", async (t) => {
  const f = await fixture(t, undefined, true);
  await assert.rejects(
    migrateNativeOpenClawSessions({
      ...f,
      assertHeld() {
        if (fs.existsSync(f.archive)) throw new Error("lease revoked after import");
      },
    }),
    /lease revoked after import/u,
  );
  assert.equal(fs.existsSync(f.pending), true);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
});

test("migration reports lease loss only after stopping the active importer and retains its archives", async (t) => {
  const f = await fixture(
    t,
    migrationApp(
      "",
      `fs.writeFileSync(path.join(__dirname, 'importer.pid'), String(process.pid));
      fs.renameSync(store, archive);
      await new Promise(resolve => setTimeout(resolve, 60000));`,
    ),
  );
  const original = fs.readFileSync(f.store);
  const transcript = fs.readFileSync(f.transcript);
  const revoked = new Error("lease revoked during import");
  await assert.rejects(
    migrateNativeOpenClawSessions({
      ...f,
      assertHeld() {
        if (fs.existsSync(f.archive)) throw revoked;
      },
    }),
    (error) => error === revoked,
  );
  const pid = Number(fs.readFileSync(path.join(f.runtimeRoot, "importer.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(fs.readFileSync(f.archive), original);
  assert.deepEqual(fs.readFileSync(f.transcript), transcript);
  assert.equal(fs.existsSync(f.pending), true);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
});

test("migration persists incomplete state before the importer starts", async (t) => {
  const f = await fixture(
    t,
    migrationApp(`if (mode === 'import') {
      const assert = require('node:assert/strict');
      const pending = path.join(process.env.OPENCLAW_STATE_DIR, '.nemoclaw-history-migration-pending');
      assert.equal(fs.readFileSync(pending, 'utf8'), 'History migration verification is incomplete.\\n');
      throw Object.assign(new Error('import failed'), {name:'ExitError',code:2});
    }`),
  );
  const original = fs.readFileSync(f.store);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert.equal(fs.existsSync(f.pending), true);
  assert.deepEqual(fs.readFileSync(f.store), original);
  assert.equal(fs.existsSync(f.archive), false);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
});

test("migration rejects transcript paths outside the main session directory", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    f.store,
    JSON.stringify({
      main: { sessionId: "session-1", sessionFile: path.join(f.root, "private.jsonl") },
    }),
  );
  assert.throws(() => inspectLegacyOpenClawSessions(f.home), /upgraded safely/u);
});

test("migration rejects traversal identifiers and malformed stores", async (t) => {
  const f = await fixture(t);
  for (const value of [
    [],
    null,
    { main: { sessionId: "../private" } },
    { main: { sessionId: "ok", sessionFile: "relative.jsonl" } },
  ]) {
    fs.writeFileSync(f.store, JSON.stringify(value));
    assert.throws(() => inspectLegacyOpenClawSessions(f.home), /upgraded safely/u);
  }
});

test("migration rejects hard-linked inputs and leaves both links unchanged", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other.jsonl");
  fs.linkSync(f.transcript, other);
  assert.throws(() => inspectLegacyOpenClawSessions(f.home), /upgraded safely/u);
  assert.equal(fs.readFileSync(other, "utf8"), fs.readFileSync(f.transcript, "utf8"));
});

test("migration rejects redirected ancestors", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.home, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => inspectLegacyOpenClawSessions(alias), /upgraded safely/u);
});

test("migration stops on a failed dry-run without importing history", async (t) => {
  const f = await fixture(
    t,
    `exports.runOpenClaw=async()=>{throw Object.assign(new Error('failed'),{name:'ExitError',code:2});};`,
  );
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert(fs.existsSync(f.store));
  assert.equal(fs.existsSync(f.pending), false);
});

test("migration rejects incomplete reports without importing history", async (t) => {
  for (const report of [null, {}, { mode: "dry-run", totals: { issues: 1, targets: 1 } }]) {
    const f = await fixture(
      t,
      `exports.runOpenClaw=async()=>{console.log(${JSON.stringify(JSON.stringify(report))})};`,
    );
    const original = fs.readFileSync(f.store);
    await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
    assert.deepEqual(fs.readFileSync(f.store), original);
    assert.equal(fs.existsSync(f.archive), false);
  }
});

test("migration process uses sealed configuration and does not inherit provider secrets", async (t) => {
  const f = await fixture(
    t,
    migrationApp(`const assert=require('node:assert/strict');
    assert.equal(process.env.NVIDIA_API_KEY,undefined); assert.equal(process.env.NODE_OPTIONS,undefined);
    assert.equal(process.env.OPENCLAW_CONFIG_PATH,path.join(__dirname,'workers','openclaw-migration-config.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8')),{});`),
  );
  const previousKey = process.env.NVIDIA_API_KEY;
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NVIDIA_API_KEY = "migration-test-provider-secret";
  process.env.NODE_OPTIONS = "--trace-warnings";
  try {
    assert.equal(await migrateNativeOpenClawSessions(f), true);
  } finally {
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
});

test("migration rejects state-owned environment overrides", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, ".openclaw", ".env"), "NODE_OPTIONS=--require=untrusted.cjs");
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert(fs.existsSync(f.store));
});

test("migration errors do not disclose malformed chat content", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.store, '{"private-chat-marker":invalid');
  assert.throws(
    () => inspectLegacyOpenClawSessions(f.home),
    (error) => error instanceof Error && !error.message.includes("private-chat-marker"),
  );
});

test("migration cancellation terminates the process before releasing the state lease", async (t) => {
  const f = await fixture(
    t,
    `exports.runOpenClaw=async()=>{await new Promise(r=>setTimeout(r,60000))};`,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(
      migrateNativeOpenClawSessions({ ...f, signal: controller.signal }),
      /upgraded safely/u,
    );
  } finally {
    clearTimeout(timer);
  }
  assert(fs.existsSync(f.store));
});

test("migration refuses a revoked state lease", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    migrateNativeOpenClawSessions({
      ...f,
      assertHeld() {
        throw new Error("lease revoked");
      },
    }),
    /lease revoked/u,
  );
  assert(fs.existsSync(f.store));
});
