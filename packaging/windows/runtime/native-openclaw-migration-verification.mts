// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function ordinaryPath(file: string, directory = false) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(!stat.isSymbolicLink());
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n);
  assert.equal(path.relative(path.resolve(file), fs.realpathSync(file)), "");
  return stat;
}

function ordinaryParents(file: string) {
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    ordinaryPath(current, true);
    if (path.dirname(current) === current) break;
  }
}

/** Hash and inspect the same opened file; never reopen a checked pathname for its contents. */
function readOriginal(file: string, visit?: (chunk: Buffer) => void) {
  const descriptor = fs.openSync(
    file,
    process.platform === "win32"
      ? "r"
      : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = ordinaryPath(file);
    assert(opened.isFile() && opened.nlink === 1n);
    assert.equal(opened.dev, named.dev);
    assert.equal(opened.ino, named.ino);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0n;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      bytes += BigInt(count);
      hash.update(chunk);
      visit?.(chunk);
    }
    const final = fs.fstatSync(descriptor, { bigint: true });
    const finalName = ordinaryPath(file);
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
      assert.equal(final[key], opened[key]);
      assert.equal(finalName[key], opened[key]);
    }
    assert.equal(bytes, opened.size);
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

type MigrationHistory = {
  store: string;
  originals: Map<string, string>;
  sessions: { key: string; id: string; events: number }[];
};

/** Runs inside the sealed Node worker, before the pinned importer can move originals. */
export function captureMigrationHistory(store: string): MigrationHistory {
  ordinaryParents(store);
  const chunks: Buffer[] = [];
  let bytes = 0;
  readOriginal(store, (chunk) => {
    bytes += chunk.length;
    assert(bytes <= 16 * 1024 * 1024);
    chunks.push(Buffer.from(chunk));
  });
  const records: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert(records && typeof records === "object" && !Array.isArray(records));
  const directory = path.dirname(store);
  const originals = new Map<string, string>();
  const counts = new Map<string, number>();
  const sessions = Object.entries(records).map(([key, record]) => {
    assert(record && typeof record === "object" && !Array.isArray(record));
    const id: unknown = record.sessionId;
    assert(typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id));
    const transcript: unknown = record.sessionFile ?? path.join(directory, `${id}.jsonl`);
    assert(typeof transcript === "string" && path.isAbsolute(transcript));
    assert.equal(path.relative(directory, path.dirname(transcript)), "");
    assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*\.jsonl$/u.test(path.basename(transcript)));
    if (!counts.has(transcript)) {
      let events = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let tail = "";
      const countLine = (line: string) => {
        // Match the pinned doctor's event count. It owns legacy codec upgrades;
        // comparing raw JSON with upgraded events would reject valid old histories.
        if (line.trim() && JSON.parse(line)) events++;
      };
      try {
        ordinaryPath(transcript);
      } catch (error) {
        // A session without a transcript is allowed by the pinned importer.
        // An explicit missing transcript is still rejected by its dry-run report.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        counts.set(transcript, 0);
        return { key, id, events: 0 };
      }
      originals.set(
        transcript,
        readOriginal(transcript, (chunk) => {
          const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n");
          tail = lines.pop()!;
          for (const line of lines) countLine(line);
        }),
      );
      countLine(tail + decoder.decode());
      counts.set(transcript, events);
    }
    return { key, id, events: counts.get(transcript)! };
  });
  // Only referenced transcripts own trajectory pointers. An unrelated pointer
  // can remain in place; the pinned doctor does not archive orphan JSON pointers.
  for (const transcript of [...originals.keys()]) {
    const pointer = `${transcript.slice(0, -6)}.trajectory-path.json`;
    try {
      ordinaryPath(pointer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    originals.set(pointer, readOriginal(pointer));
  }
  // The doctor also archives unreferenced JSONL. Preserve its bytes without
  // treating malformed or unreferenced records as chat events.
  const names = fs.readdirSync(directory);
  assert(names.length <= 100_000);
  for (const name of names) {
    const file = path.join(directory, name);
    if (name.endsWith(".jsonl") && !originals.has(file)) originals.set(file, readOriginal(file));
  }
  return { store, originals, sessions };
}

/** Verify post-import state before the worker can report a successful exit. */
export function verifyMigrationHistory(history: MigrationHistory) {
  const agent = path.dirname(path.dirname(history.store));
  const archiveDirectory = path.join(agent, "session-sqlite-import-archive");
  ordinaryParents(path.join(archiveDirectory, "entry"));
  const names = fs.readdirSync(archiveDirectory);
  assert(names.length <= 100_000);
  const archiveHashes = new Map<string, string>();
  for (const [original, digest] of history.originals) {
    assert.throws(() => fs.lstatSync(original), { code: "ENOENT" });
    const basename = path
      .basename(original)
      .replace(/[^A-Za-z0-9_.-]+/gu, "_")
      .slice(0, 160);
    const candidates = names.filter((name) => {
      const index = name.lastIndexOf(".imported-");
      return (
        index >= 0 &&
        name.slice(0, index).endsWith(`.${basename}`) &&
        /^[0-9]+(?:\.[0-9]+)?$/u.test(name.slice(index + ".imported-".length))
      );
    });
    assert(
      candidates.some((name) => {
        if (!archiveHashes.has(name))
          archiveHashes.set(name, readOriginal(path.join(archiveDirectory, name)));
        return archiveHashes.get(name) === digest;
      }),
    );
  }
  // The pinned importer archives an empty index without creating a database.
  // There are no session mappings or events to verify in that case.
  if (history.sessions.length === 0) return;
  const sqlite = path.join(agent, "agent", "openclaw-agent.sqlite");
  ordinaryParents(sqlite);
  const before = ordinaryPath(sqlite);
  const database = new DatabaseSync(sqlite, { readOnly: true });
  try {
    const opened = ordinaryPath(sqlite);
    assert.equal(opened.dev, before.dev);
    assert.equal(opened.ino, before.ino);
    const session = database.prepare(
      "SELECT current_session_id FROM session_nodes WHERE session_key = ? AND entry_valid = 1",
    );
    const events = database.prepare(
      "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
    );
    for (const expected of history.sessions) {
      assert.equal(session.get(expected.key)?.current_session_id, expected.id);
      const count = events.get(expected.id)?.count;
      assert(typeof count === "number" && count >= expected.events);
    }
    assert.deepEqual(
      database
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => Object.values(row)[0]),
      ["ok"],
    );
  } finally {
    database.close();
  }
}
