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
});
