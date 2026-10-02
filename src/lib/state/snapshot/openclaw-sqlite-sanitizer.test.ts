// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { textContainsHighConfidenceCredential } from "../../security/credential-filter.js";
import { withoutOpenClawSqliteMachineAuthority } from "./openclaw-sqlite-sanitizer.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-state-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "openclaw.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw SQLite archive sanitation", () => {
  it("removes machine-local authority while preserving ordinary state and byte length", () => {
    const sourcePath = databasePath();
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE device_identities (identity_key TEXT PRIMARY KEY, private_key_pem TEXT);
      CREATE TABLE device_auth_tokens (device_id TEXT PRIMARY KEY, token TEXT);
      CREATE TABLE device_pairing_paired (device_id TEXT PRIMARY KEY, display_name TEXT, tokens_json TEXT);
      CREATE TABLE session_state (session_id TEXT PRIMARY KEY, summary TEXT);
    `);
    const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "PRIVATE KEY-----"].join(" ");
    source
      .prepare("INSERT INTO device_identities VALUES (?, ?)")
      .run("primary", `${begin}\nmaterial\n${end}`);
    source
      .prepare("INSERT INTO device_auth_tokens VALUES (?, ?)")
      .run("device-1", "private-device-token");
    source
      .prepare("INSERT INTO device_pairing_paired VALUES (?, ?, ?)")
      .run("device-1", "workstation", JSON.stringify({ operator: "private-device-token" }));
    source.prepare("INSERT INTO session_state VALUES (?, ?)").run("session-1", "keep me");
    source.close();
    const original = readFileSync(sourcePath);

    const result = withoutOpenClawSqliteMachineAuthority(original);

    expect(result).toBeInstanceOf(Buffer);
    const sanitized = result as Buffer;
    expect(sanitized.byteLength).toBe(original.byteLength);
    expect(textContainsHighConfidenceCredential(sanitized.toString("utf8"))).toBe(false);
    const sanitizedPath = databasePath();
    writeFileSync(sanitizedPath, sanitized, { flag: "wx", mode: 0o600 });
    const inspection = new DatabaseSync(sanitizedPath, { readOnly: true });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM device_identities").get()).toEqual({
      count: 0,
    });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM device_auth_tokens").get()).toEqual({
      count: 0,
    });
    expect(inspection.prepare("SELECT * FROM device_pairing_paired").get()).toEqual({
      device_id: "device-1",
      display_name: "workstation",
      tokens_json: null,
    });
    expect(inspection.prepare("SELECT * FROM session_state").get()).toEqual({
      session_id: "session-1",
      summary: "keep me",
    });
    inspection.close();
  });

  it("fails closed for a malformed database", () => {
    expect(withoutOpenClawSqliteMachineAuthority(Buffer.from("not sqlite"))).toContain(
      "not a SQLite database",
    );
  });
});
