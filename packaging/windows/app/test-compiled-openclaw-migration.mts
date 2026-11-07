// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateNativeOpenClawSessions } from "../runtime/native-openclaw-migration.mts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const app = argument("--app-root");
const runtimeRoot = argument("--runtime-root");
const output = argument("--output");
const portable = process.argv.includes("--portable-proof");
if (
  !portable &&
  (process.platform !== "win32" || process.arch !== "arm64" || process.versions.node !== "22.23.2")
)
  throw new Error("Compiled migration controls require the canonical Windows ARM64 Node.");
assert.equal(fs.existsSync(output), false, "Migration control output must be fresh.");
const home = path.join(output, "synthetic-home");
const sessions = path.join(home, ".openclaw", "agents", "main", "sessions");
const entry = path.join(app, "openclaw-app.cjs");
const worker = path.join(runtimeRoot, "workers", "openclaw-migrate.cjs");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const appSha256 = hash(entry);
const workerSha256 = hash(worker);
const sessionId = "compiled-migration-history";
const sessionKey = "agent:main:main";
const timestamp = "2026-10-11T12:00:00.000Z";
const transcript = path.join(sessions, `${sessionId}.jsonl`);
const store = path.join(sessions, "sessions.json");
const events = [
  { type: "session", version: 3, id: sessionId, timestamp, cwd: home },
  {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text: "retained user turn" }],
      timestamp: Date.parse(timestamp),
    },
  },
  {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "retained assistant turn" }],
      api: "openai-completions",
      provider: "synthetic",
      model: "synthetic",
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  },
];
const originalTranscript = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const originalStore = JSON.stringify({
  [sessionKey]: { sessionId, sessionFile: transcript, updatedAt: Date.parse(timestamp) },
});

function filesBelow(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    assert.equal(item.isSymbolicLink(), false);
    const file = path.join(directory, item.name);
    if (item.isDirectory()) return filesBelow(file);
    assert(item.isFile());
    return [file];
  });
}

const result = {
  schemaVersion: 1,
  classification: "compiled-openclaw-session-migration-controls",
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  portableProof: portable,
  appSha256,
  workerSha256,
  passed: false,
  originalArchivesPreserved: false,
  importedEvents: 0,
  repeatSkipped: false,
  syntheticStateRemoved: false,
  // The caller owns this fresh fixture. Named-mutex and installed acceptance
  // remain separate Windows tests; this check exercises the actual importer.
  installedAcceptance: false,
  nativeStateOwnershipProven: false,
};
fs.mkdirSync(output, { recursive: true });
try {
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(transcript, originalTranscript, { flag: "wx" });
  fs.writeFileSync(store, originalStore, { flag: "wx" });
  const options = { home, entry, runtimeRoot, node: process.execPath, assertHeld() {} };
  assert.equal(await migrateNativeOpenClawSessions(options), true);
  assert.equal(fs.existsSync(store), false);
  assert.equal(fs.existsSync(transcript), false);
  const archives = filesBelow(path.join(path.dirname(sessions), "session-sqlite-import-archive"));
  const stores = archives.filter((file) =>
    path.basename(file).startsWith("legacy-store.sessions.json.imported-"),
  );
  assert.equal(stores.length, 1);
  assert.equal(fs.readFileSync(stores[0], "utf8"), originalStore);
  assert.equal(
    archives.filter((file) => fs.readFileSync(file, "utf8") === originalTranscript).length,
    1,
  );
  result.originalArchivesPreserved = true;
  const agentDatabases = filesBelow(path.join(home, ".openclaw")).filter((file) => {
    if (!file.endsWith(".sqlite")) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_nodes'")
          .get(),
      );
    } finally {
      db.close();
    }
  });
  assert.equal(agentDatabases.length, 1);
  const db = new DatabaseSync(agentDatabases[0], { readOnly: true });
  try {
    assert.equal(
      db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(sessionKey)?.current_session_id,
      sessionId,
    );
    const imported = db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.event_json)));
    assert.deepEqual(imported, events);
    result.importedEvents = imported.length;
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get()!)[0], "ok");
  } finally {
    db.close();
  }
  assert.equal(await migrateNativeOpenClawSessions(options), false);
  result.repeatSkipped = true;
  assert.equal(hash(entry), appSha256);
  assert.equal(hash(worker), workerSha256);
  result.passed = true;
} finally {
  try {
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(fs.existsSync(home), false);
    result.syntheticStateRemoved = true;
  } catch (error) {
    result.passed = false;
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "migration-controls.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
  }
}
console.log(
  "PASS: compiled importer preserves chat history and original archives, then skips repeated migration.",
);
