// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { inspectExtractedDcodeSessionsDatabase } from "./dcode-session-credential-scan.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createDatabase(): { database: DatabaseSync; fixture: string; path: string } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-session-scan-"));
  fixtures.push(fixture);
  const databasePath = path.join(fixture, ".deepagents", ".state", "sessions.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return { database: new DatabaseSync(databasePath), fixture, path: databasePath };
}

describe("DCode session database credential scan", () => {
  it("inspects logical values instead of token-shaped SQLite page framing", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE sessions (prefix TEXT, content TEXT)");
    fixture.database
      .prepare("INSERT INTO sessions VALUES (?, ?)")
      .run("sk-", "benign-session-text");
    fixture.database.close();

    expect(fs.readFileSync(fixture.path).includes(Buffer.from("sk-benign-session-text"))).toBe(
      true,
    );
    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(false);
  });

  it("rejects a credential stored in a logical SQLite cell", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE sessions (content TEXT)");
    fixture.database.prepare("INSERT INTO sessions VALUES (?)").run(`ghp_${"0123456789abcdef"}`);
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(true);
  });

  it("rejects a credential stored in an active WAL frame", () => {
    const fixture = createDatabase();
    try {
      fixture.database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      fixture.database.exec("CREATE TABLE sessions (content TEXT)");
      fixture.database.prepare("INSERT INTO sessions VALUES (?)").run(`ghp_${"fedcba9876543210"}`);
      expect(fs.statSync(`${fixture.path}-wal`).size).toBeGreaterThan(0);

      expect(
        inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
      ).toBe(true);
    } finally {
      fixture.database.close();
    }
  });

  it("rejects an opaque credential assignment stored in a session transcript", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE sessions (content TEXT)");
    fixture.database
      .prepare("INSERT INTO sessions VALUES (?)")
      .run('Example configuration: {"API_KEY":"not-a-secret-marker"}');
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(true);
  });

  it("preserves ordinary configuration text stored in a session transcript", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE sessions (content TEXT)");
    fixture.database
      .prepare("INSERT INTO sessions VALUES (?)")
      .run('Example configuration: {"model":"not-a-secret-marker"}');
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(false);
  });

  it("preserves the pinned QuickJS diagnostic embedded in interpreter checkpoints", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE writes (channel TEXT, value BLOB)");
    fixture.database
      .prepare("INSERT INTO writes VALUES (?, ?)")
      .run("_quickjs_snapshot_payload", Buffer.from("\0unexpected token: '%.*s'\0"));
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(false);
  });

  it("rejects the synthetic observability key stored in native history", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE writes (channel TEXT, value BLOB)");
    fixture.database
      .prepare("INSERT INTO writes VALUES (?, ?)")
      .run("messages", Buffer.from(`My key is sk-${"EXAMPLE0000000000000000000000"}.`));
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(true);
  });

  it("reports a fixed inspection failure without exposing corrupt database content", () => {
    const fixture = createDatabase();
    fixture.database.close();
    fs.writeFileSync(fixture.path, "corrupt database containing private credential text");
    const reasons: string[] = [];
    expect(
      inspectExtractedDcodeSessionsDatabase(
        fixture.fixture,
        ".deepagents/.state/sessions.db",
        (reason) => reasons.push(reason),
      ),
    ).toBe(null);
    expect(reasons).toEqual(["sqlite-query"]);
  });

  it("keeps credential checks on text cells containing diagnostic-shaped assignments", () => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE messages (content TEXT)");
    fixture.database.prepare("INSERT INTO messages VALUES (?)").run("unexpected token: '%.*s'");
    fixture.database.close();
    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(true);
  });

  it.each([
    ["changed diagnostic value", "\0unexpected token: 'private-value'\0"],
    ["missing diagnostic delimiter", "\0unexpected token: '%.*s'"],
    ["changed diagnostic format", "\0unexpected token: '%s'\0"],
    ["adjacent provider credential", `\0unexpected token: '%.*s'\0ghp_${"0123456789abcdef"}`],
    ["adjacent opaque credential", '\0unexpected token: \'%.*s\'\0{"API_KEY":"private-value"}'],
  ])("rejects %s in interpreter checkpoints", (_label, content) => {
    const fixture = createDatabase();
    fixture.database.exec("CREATE TABLE writes (channel TEXT, value BLOB)");
    fixture.database
      .prepare("INSERT INTO writes VALUES (?, ?)")
      .run("_quickjs_snapshot_payload", Buffer.from(content));
    fixture.database.close();

    expect(
      inspectExtractedDcodeSessionsDatabase(fixture.fixture, ".deepagents/.state/sessions.db"),
    ).toBe(true);
  });
});
