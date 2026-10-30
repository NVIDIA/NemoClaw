// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type HistoryFixture = {
  home: string;
  sessionId: string;
  sessionKey: string;
  store: string;
  transcript: string;
  storeText: string;
  transcriptText: string;
};

export function readHistoryFixtureFile(file: string) {
  const descriptor = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    assert(opened.isFile() && opened.nlink === 1n);
    assert(
      named.isFile() &&
        !named.isSymbolicLink() &&
        named.dev === opened.dev &&
        named.ino === opened.ino,
      "The history fixture path changed identity.",
    );
    const limit = 16 * 1024 * 1024;
    assert(opened.size <= limit, "The history fixture exceeds its bound.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - bytes + 1));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      assert(bytes <= limit, "The history fixture exceeds its bound.");
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function filesBelow(directory: string): string[] {
  const files: string[] = [];
  let entries = 0;
  const visit = (current: string) => {
    const info = fs.lstatSync(current);
    assert(info.isDirectory() && !info.isSymbolicLink());
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert(++entries <= 10000, "The history inventory exceeds its bound.");
      assert(!entry.isSymbolicLink());
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert(entry.isFile());
        files.push(file);
      }
    }
  };
  visit(directory);
  return files;
}

export function verifyInstalledHistory(fixture: HistoryFixture) {
  assert(path.isAbsolute(fixture.home));
  assert.match(fixture.sessionId, /^migration-[a-f0-9]{32}$/u);
  assert.equal(fixture.sessionKey, `agent:main:${fixture.sessionId}`);
  const sessions = path.join(fixture.home, ".openclaw", "agents", "main", "sessions");
  assert.equal(fixture.store, path.join(sessions, "sessions.json"));
  assert.equal(fixture.transcript, path.join(sessions, `${fixture.sessionId}.jsonl`));
  for (const file of [fixture.store, fixture.transcript])
    assert.throws(() => fs.lstatSync(file), { code: "ENOENT" });
  const archiveRoot = path.join(path.dirname(sessions), "session-sqlite-import-archive");
  const archives = filesBelow(archiveRoot);
  const storeArchives = archives.filter((file) =>
    /^legacy-store\.sessions\.json\.imported-[0-9]+(?:\.[0-9]+)?$/u.test(path.basename(file)),
  );
  assert.equal(storeArchives.length, 1);
  assert.equal(readHistoryFixtureFile(storeArchives[0]).toString("utf8"), fixture.storeText);
  assert.equal(
    archives.filter(
      (file) => readHistoryFixtureFile(file).toString("utf8") === fixture.transcriptText,
    ).length,
    1,
  );
  const databases = filesBelow(path.join(fixture.home, ".openclaw")).filter((file) => {
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
  assert.equal(databases.length, 1);
  const db = new DatabaseSync(databases[0], { readOnly: true });
  const expected = fixture.transcriptText
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  try {
    assert.equal(
      db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(fixture.sessionKey)?.current_session_id,
      fixture.sessionId,
    );
    const actual = db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(fixture.sessionId)
      .map((row) => JSON.parse(String(row.event_json)));
    assert.deepEqual(actual, expected);
    assert.deepEqual(
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => Object.values(row)[0]),
      ["ok"],
    );
  } finally {
    db.close();
  }
  return {
    classification: "installed-openclaw-history-observation",
    importedEvents: expected.length,
    archives: archives
      .map((file) => ({
        file: path.relative(archiveRoot, file),
        sha256: createHash("sha256").update(readHistoryFixtureFile(file)).digest("hex"),
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4);
  const fixture = JSON.parse(readHistoryFixtureFile(process.argv[2]).toString("utf8"));
  fs.writeFileSync(process.argv[3], JSON.stringify(verifyInstalledHistory(fixture)) + "\n", {
    flag: "wx",
  });
}
