// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT,
  parseOpenClawTranscriptSource,
} from "./openclaw-transcript-source";

let root: string;
let staging: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-transcript-source-"));
  staging = path.join(root, ".nemoclaw-staging", "sessions-export-main-0123456789ab");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runScriptWith(nodeOptions: string[], ...files: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      ...nodeOptions,
      "--no-warnings",
      "-e",
      OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT,
      root,
      "main",
      staging,
      ...files,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, output: result.stdout, stderr: result.stderr };
}

function runScript(...files: string[]) {
  return runScriptWith([], ...files);
}

function writeDatabase(tables = ["transcript_events", "trajectory_runtime_events"]): string {
  const directory = path.join(root, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, "openclaw-agent.sqlite");
  const database = new DatabaseSync(databasePath);
  const rows: [string, string, number, string][] = [
    ["transcript_events", "sid-a", 1, '{"type":"message","id":"m1"}'],
    ["transcript_events", "sid-a", 0, '{"type":"session","id":"sid-a"}'],
    ["transcript_events", "sid-b", 0, '{"type":"session","id":"sid-b"}'],
    ["trajectory_runtime_events", "sid-a", 0, '{"traceSchema":"openclaw-trajectory"}'],
  ];
  tables.map((table) =>
    database.exec(`CREATE TABLE ${table} (session_id TEXT, seq INTEGER, event_json TEXT)`),
  );
  rows
    .filter(([table]) => tables.includes(table))
    .map(([table, sessionId, seq, line]) =>
      database
        .prepare(`INSERT INTO ${table} (session_id, seq, event_json) VALUES (?, ?, ?)`)
        .run(sessionId, seq, line),
    );
  database.close();
  return databasePath;
}

function writeLegacyStore(): string {
  const store = path.join(root, ".openclaw", "agents", "main", "sessions");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "sid-a.jsonl"), '{"type":"session"}\n');
  fs.writeFileSync(path.join(root, "unrelated.txt"), "unrelated\n");
  return store;
}

describe("OPENCLAW_TRANSCRIPT_SOURCE_SCRIPT (#12673)", () => {
  it("stages database transcripts as owner-only JSONL files in seq order", () => {
    writeDatabase();

    const result = runScript("sid-a.jsonl", "sid-a.trajectory.jsonl", "sid-b.jsonl");

    expect(result).toMatchObject({ status: 0, output: "staged\n" });
    expect(fs.readFileSync(path.join(staging, "sid-a.jsonl"), "utf8")).toBe(
      '{"type":"session","id":"sid-a"}\n{"type":"message","id":"m1"}\n',
    );
    expect(fs.readFileSync(path.join(staging, "sid-a.trajectory.jsonl"), "utf8")).toBe(
      '{"traceSchema":"openclaw-trajectory"}\n',
    );
    expect(fs.readdirSync(staging).sort()).toEqual([
      "sid-a.jsonl",
      "sid-a.trajectory.jsonl",
      "sid-b.jsonl",
    ]);
    expect(fs.statSync(staging).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(staging, "sid-a.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("reports sessions with no stored rows and stages nothing", () => {
    writeDatabase();

    const result = runScript("sid-a.jsonl", "sid-b.trajectory.jsonl", "sid-c.jsonl");

    expect(result).toMatchObject({ status: 2, output: "sid-b.trajectory.jsonl\nsid-c.jsonl\n" });
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("streams a transcript that is larger than the script heap", () => {
    const database = new DatabaseSync(writeDatabase());
    const line = JSON.stringify({ type: "message", text: "x".repeat(16_000) });
    const insert = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json) VALUES ('sid-big', ?, ?)",
    );
    database.exec("BEGIN");
    Array.from({ length: 3_000 }, (_, seq) => insert.run(seq, line));
    database.exec("COMMIT");
    database.close();

    const result = runScriptWith(["--max-old-space-size=24"], "sid-big.jsonl");

    expect(result).toMatchObject({ status: 0, output: "staged\n" });
    expect(fs.statSync(path.join(staging, "sid-big.jsonl")).size).toBe(3_000 * (line.length + 1));
  });

  it("refuses a hard-linked database file", () => {
    fs.linkSync(writeDatabase(), path.join(root, "other.sqlite"));

    const result = runScript("sid-a.jsonl");

    expect(result.status).toBe(3);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("refuses an unsupported database schema", () => {
    writeDatabase(["transcript_events"]);

    const result = runScript("sid-a.trajectory.jsonl");

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("no trajectory_runtime_events table");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("refuses a symlinked database path", () => {
    const real = path.join(root, "elsewhere");
    fs.mkdirSync(real);
    fs.mkdirSync(path.join(root, ".openclaw", "agents", "main"), { recursive: true });
    fs.symlinkSync(real, path.join(root, ".openclaw", "agents", "main", "agent"));
    fs.writeFileSync(path.join(real, "openclaw-agent.sqlite"), "");

    const result = runScript("sid-a.jsonl");

    expect(result.status).toBe(3);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("refuses a symlinked legacy session store", () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "sid-a.jsonl"), '{"type":"session"}\n');
    fs.mkdirSync(path.join(root, ".openclaw", "agents", "main"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, ".openclaw", "agents", "main", "sessions"));

    const result = runScript("sid-a.jsonl");

    expect(result).toMatchObject({ status: 3, output: "" });
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("accepts regular single-link legacy files in place", () => {
    writeLegacyStore();

    expect(runScript("sid-a.jsonl")).toMatchObject({ status: 0, output: "" });
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("reports missing, symlinked, and hard-linked legacy files", () => {
    const store = writeLegacyStore();
    fs.symlinkSync(path.join(store, "sid-a.jsonl"), path.join(store, "sid-l.jsonl"));
    fs.linkSync(path.join(root, "unrelated.txt"), path.join(store, "sid-h.jsonl"));

    const result = runScript("sid-a.jsonl", "sid-m.jsonl", "sid-l.jsonl", "sid-h.jsonl");

    expect(result).toMatchObject({ status: 1, output: "sid-m.jsonl\nsid-l.jsonl\nsid-h.jsonl\n" });
  });
});

describe("parseOpenClawTranscriptSource", () => {
  const files = ["sid-a.jsonl", "sid-b.jsonl"];

  it.each([
    [{ status: 0, output: "" }, { kind: "legacy" }],
    [{ status: 0, output: "staged\n" }, { kind: "staged" }],
    [
      { status: 1, output: "sid-b.jsonl\n" },
      { kind: "legacy-abnormal", files: ["sid-b.jsonl"] },
    ],
    [
      { status: 2, output: "sid-a.jsonl\n" },
      { kind: "stored-missing", files: ["sid-a.jsonl"] },
    ],
    [
      { status: 1, output: "" },
      { kind: "failed", detail: "" },
    ],
    [
      { status: 2, output: "gateway unreachable\n" },
      { kind: "failed", detail: "; output: gateway unreachable" },
    ],
    [
      { status: 0, output: "sid-a.jsonl\n" },
      { kind: "failed", detail: "; output: sid-a.jsonl" },
    ],
    [
      { status: null, output: "" },
      { kind: "failed", detail: "" },
    ],
  ])("parses %j", (result, expected) => {
    expect(parseOpenClawTranscriptSource(result, files)).toEqual(expected);
  });
});
