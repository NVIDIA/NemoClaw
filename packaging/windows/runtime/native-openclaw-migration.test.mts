// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import {
  inspectLegacyOpenClawSessions,
  migrateNativeOpenClawSessions,
} from "./native-openclaw-migration.mts";

async function fixture(t: test.TestContext, source?: string) {
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
  await build({
    entryPoints: [
      fileURLToPath(new URL("./native-openclaw-migration-worker.mts", import.meta.url)),
    ],
    outfile: path.join(workers, "openclaw-migrate.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  fs.writeFileSync(path.join(workers, "openclaw-migration-config.json"), "{}");
  const entry = path.join(runtimeRoot, "app.cjs");
  fs.writeFileSync(
    entry,
    source ??
      `exports.runOpenClaw = async argv => {
    const fs=require('node:fs'); const mode=argv[4]; const store=argv[6];
    if (mode==='import') fs.renameSync(store,store+'.archive');
    console.log(JSON.stringify({mode,totals:{issues:0,targets:1}}));
    throw Object.assign(new Error('done'),{name:'ExitError',code:0});
  };`,
  );
  return {
    root,
    home,
    sessions,
    transcript,
    store,
    runtimeRoot,
    entry,
    node: process.execPath,
    assertHeld() {},
  };
}

test("migration runs dry-run and import, preserves originals, and skips migrated state", async (t) => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.store);
  assert.equal(await migrateNativeOpenClawSessions(f), true);
  assert.deepEqual(fs.readFileSync(f.store + ".archive"), original);
  assert.equal(await migrateNativeOpenClawSessions(f), false);
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
});

test("migration rejects incomplete reports without importing history", async (t) => {
  const f = await fixture(t, `exports.runOpenClaw=async()=>{console.log('{}')};`);
  await assert.rejects(migrateNativeOpenClawSessions(f), /upgraded safely/u);
  assert(fs.existsSync(f.store));
});

test("migration process uses sealed configuration and does not inherit provider secrets", async (t) => {
  const f = await fixture(
    t,
    `exports.runOpenClaw=async argv=>{
    const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path');
    assert.equal(process.env.NVIDIA_API_KEY,undefined); assert.equal(process.env.NODE_OPTIONS,undefined);
    assert.equal(process.env.OPENCLAW_CONFIG_PATH,path.join(__dirname,'workers','openclaw-migration-config.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8')),{});
    const mode=argv[4]; if(mode==='import')fs.renameSync(argv[6],argv[6]+'.archive');
    console.log(JSON.stringify({mode,totals:{issues:0,targets:1}}));
  };`,
  );
  assert.equal(await migrateNativeOpenClawSessions(f), true);
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
