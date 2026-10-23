// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw 2026.9 and later keep session transcripts in the per-agent SQLite
// database `agents/<id>/agent/openclaw-agent.sqlite` (tables
// `transcript_events` and `trajectory_runtime_events`) and write no
// `<sessionId>.jsonl` files. Each `event_json` row is one line of the earlier
// `<sessionId>.jsonl` / `<sessionId>.trajectory.jsonl` format. Earlier OpenClaw
// releases write those files under `agents/<id>/sessions`.
//
// OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT runs inside the sandbox with
// `node --no-warnings -e <script> <root> <agent> <stagingDir> <file>...`:
//   - When the database exists, it reads the selected sessions in one
//     read-only transaction and streams the rows of each `<file>` into the new
//     owner-only `<stagingDir>`, so memory use does not grow with the history.
//     It prints `staged` and exits 0. When a selected session has no rows, it
//     removes `<stagingDir>`, prints each affected file, and exits 2.
//   - When the database does not exist, it checks each file in the legacy
//     store. It exits 0 with no output when every file is a regular file with
//     one link. Otherwise it prints each affected file and exits 1.
//   - It exits 3 for an unsafe path (a symlinked path component, a database
//     file or companion with more than one link, or a store path that is not
//     a directory) and 5 for an unsupported database schema. A
//     failure after it creates `<stagingDir>` removes the directory first.
// The path checks follow OPENCLAW_SQLITE_COPY_SCRIPT in src/lib/state/sandbox.ts.

export const OPENCLAW_TRANSCRIPT_SOURCE_TIMEOUT_MS = 120_000;

export const OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [root, agent, stagingDir, ...files] = process.argv.slice(1);
function fail(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}
function existingPath(relative, finalIsFile) {
  let cursor = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    const file = finalIsFile && index === parts.length - 1;
    if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      fail(3, "unsafe OpenClaw session store path");
    }
  }
  return cursor;
}
const database = existingPath(".openclaw/agents/" + agent + "/agent/openclaw-agent.sqlite", true);
if (database === null) {
  const store = existingPath(".openclaw/agents/" + agent + "/sessions", false);
  const abnormal = files.filter((file) => {
    if (store === null) return true;
    try {
      const stat = fs.lstatSync(path.join(store, file));
      return !stat.isFile() || stat.nlink !== 1;
    } catch {
      return true;
    }
  });
  if (abnormal.length > 0) {
    process.stdout.write(abnormal.join("\n") + "\n");
    process.exit(1);
  }
  process.exit(0);
}
for (const suffix of ["-journal", "-shm", "-wal"]) {
  try {
    const companion = fs.lstatSync(database + suffix);
    if (companion.isSymbolicLink() || !companion.isFile() || companion.nlink !== 1) {
      fail(3, "unsafe OpenClaw session database companion");
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
const { DatabaseSync } = require("node:sqlite");
const handle = new DatabaseSync(database, { allowExtension: false, readOnly: true, timeout: 2_000 });
const missing = [];
let created = false;
function removeStaging() {
  if (created) fs.rmSync(stagingDir, { recursive: true, force: true });
}
function reject(code, message) {
  removeStaging();
  fail(code, message);
}
try {
  handle.exec("PRAGMA query_only = ON; BEGIN");
  const tables = new Set(
    handle.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name),
  );
  const selected = files.map((file) => {
    const trajectory = file.endsWith(".trajectory.jsonl");
    const table = trajectory ? "trajectory_runtime_events" : "transcript_events";
    if (!tables.has(table)) fail(5, "unsupported OpenClaw session database: no " + table + " table");
    const sessionId = file.slice(0, -(trajectory ? ".trajectory.jsonl" : ".jsonl").length);
    return { file, table, sessionId };
  });
  fs.mkdirSync(path.dirname(stagingDir), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(stagingDir), 0o700);
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  created = true;
  for (const { file, table, sessionId } of selected) {
    const query = handle.prepare(
      "SELECT event_json AS line FROM " + table + " WHERE session_id = ? ORDER BY seq",
    );
    const descriptor = fs.openSync(path.join(stagingDir, file), "wx", 0o600);
    let rows = 0;
    try {
      for (const row of query.iterate(sessionId)) {
        if (typeof row.line !== "string" || row.line.includes("\n")) {
          reject(5, "unsupported OpenClaw session database: invalid event row");
        }
        fs.writeSync(descriptor, row.line + "\n");
        rows += 1;
      }
    } finally {
      fs.closeSync(descriptor);
    }
    if (rows === 0) missing.push(file);
  }
  handle.exec("COMMIT");
} catch (error) {
  removeStaging();
  throw error;
} finally {
  handle.close();
}
if (missing.length > 0) {
  removeStaging();
  process.stdout.write(missing.join("\n") + "\n");
  process.exit(2);
}
process.stdout.write("staged\n");
`;

export type OpenClawTranscriptSource =
  | { kind: "legacy" }
  | { kind: "staged" }
  | { kind: "legacy-abnormal"; files: string[] }
  | { kind: "stored-missing"; files: string[] }
  | { kind: "failed"; detail: string };

/** Interpret the exit status and stdout of OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT. */
export function parseOpenClawTranscriptSource(
  result: { status: number | null; output?: string },
  files: readonly string[],
): OpenClawTranscriptSource {
  const lines = (result.output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (result.status === 0 && lines.length === 0) return { kind: "legacy" };
  if (result.status === 0 && lines.length === 1 && lines[0] === "staged") return { kind: "staged" };
  // Only lines that name a requested file are valid reports. Other output, or
  // a report with no files, is a sandbox or gateway failure and fails closed.
  const recognized = new Set(files);
  const reported = lines.length > 0 && lines.every((line) => recognized.has(line));
  if (result.status === 1 && reported) return { kind: "legacy-abnormal", files: lines };
  if (result.status === 2 && reported) return { kind: "stored-missing", files: lines };
  return { kind: "failed", detail: lines.length > 0 ? `; output: ${lines.join(", ")}` : "" };
}
