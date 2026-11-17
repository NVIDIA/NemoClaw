// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  textContainsCredential,
  textContainsHighConfidenceCredential,
} from "../../security/credential-filter.js";
import { withoutOpenClawSqliteMachineAuthority } from "./openclaw-sqlite-sanitizer.js";
import { inspectExtractedOpenClawDatabase } from "./sqlite-credential-scan.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-state-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "openclaw.sqlite");
}

function sanitizedBytes(original: Buffer): Buffer {
  const result = withoutOpenClawSqliteMachineAuthority(original);
  expect(result).toBeInstanceOf(Buffer);
  return result as Buffer;
}

function scanForCredential(bytes: Buffer): boolean | null {
  const scanRoot = path.dirname(databasePath());
  writeFileSync(path.join(scanRoot, "openclaw.sqlite"), bytes, { mode: 0o600 });
  return inspectExtractedOpenClawDatabase(scanRoot, "openclaw.sqlite");
}

function execAndMemoryState(otherPluginIds: string[]) {
  const sourcePath = databasePath();
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE exec_approvals_config (
      config_key TEXT NOT NULL PRIMARY KEY, raw_json TEXT NOT NULL, has_socket_token INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE plugin_state_entries (
      plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
      value_json TEXT NOT NULL, PRIMARY KEY (plugin_id, namespace, entry_key)
    ) STRICT;
  `);
  const approvals = {
    version: 1,
    socket: { path: "/run/exec.sock", token: "private-exec-socket-token" },
    agents: { main: { allowlist: [{ pattern: "/usr/bin/git" }] } },
  };
  source
    .prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?)")
    .run("current", JSON.stringify(approvals, null, 2), 1);
  const insert = source.prepare("INSERT INTO plugin_state_entries VALUES (?, ?, ?, ?)");
  const provenance = { version: 1, fileHash: "a".repeat(64), sessionKey: "agent:main:main" };
  insert.run("core:memory-artifact-provenance", "workspace-files", "a", JSON.stringify(provenance));
  for (const pluginId of otherPluginIds) {
    insert.run(pluginId, "workspace-files", "b", JSON.stringify(provenance));
  }
  source.close();
  return { original: readFileSync(sourcePath), approvals, provenance };
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

  it("removes the exec approvals socket token and the memory provenance session key", () => {
    const { original, approvals, provenance } = execAndMemoryState(["other-plugin"]);
    expect(textContainsCredential(original.toString("utf8"))).toBe(true);

    const sanitized = sanitizedBytes(original);
    expect(sanitized.byteLength).toBe(original.byteLength);
    const sanitizedPath = databasePath();
    writeFileSync(sanitizedPath, sanitized, { flag: "wx", mode: 0o600 });
    const inspection = new DatabaseSync(sanitizedPath, { readOnly: true });
    try {
      const row = inspection
        .prepare("SELECT raw_json, has_socket_token FROM exec_approvals_config")
        .get();
      expect(row?.has_socket_token).toBe(0);
      expect(JSON.parse(String(row?.raw_json))).toEqual({
        version: 1,
        socket: { path: "/run/exec.sock" },
        agents: approvals.agents,
      });
      const entries = inspection
        .prepare("SELECT plugin_id, value_json FROM plugin_state_entries ORDER BY plugin_id")
        .all()
        .map((entry) => [entry.plugin_id, JSON.parse(String(entry.value_json))]);
      expect(entries).toEqual([
        ["core:memory-artifact-provenance", { version: 1, fileHash: "a".repeat(64) }],
        ["other-plugin", provenance],
      ]);
    } finally {
      inspection.close();
    }
  });

  it("leaves no OpenClaw credential finding after removing the socket token and session key", () => {
    const { original } = execAndMemoryState([]);
    expect(scanForCredential(original)).toBe(true);

    expect(scanForCredential(sanitizedBytes(original))).toBe(false);
  });

  it("fails closed for a malformed database", () => {
    expect(withoutOpenClawSqliteMachineAuthority(Buffer.from("not sqlite"))).toContain(
      "not a SQLite database",
    );
  });

  it("retires only the archived global gateway lease without changing the source database", () => {
    const sourcePath = databasePath();
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE state_leases (
        scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
        expires_at INTEGER, payload_json TEXT, PRIMARY KEY (scope, lease_key)
      );
    `);
    const insert = source.prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?)");
    const expiresAt = Date.now() + 300_000;
    const payload = '{"owner":{"host":"retired-container"}}';
    insert.run("gateway-owner", "global", "retired-gateway", expiresAt, payload);
    insert.run("gateway-owner", "other", "unrelated-gateway", expiresAt, payload);
    insert.run("startup-migration", "global", "migration-owner", expiresAt, payload);
    insert.run("other", "global", "unrelated-owner", expiresAt, payload);
    source.close();
    const original = readFileSync(sourcePath);
    const result = withoutOpenClawSqliteMachineAuthority(original);
    expect(result).toBeInstanceOf(Buffer);
    expect((result as Buffer).byteLength).toBe(original.byteLength);
    expect(readFileSync(sourcePath)).toEqual(original);
    const sanitizedPath = databasePath();
    writeFileSync(sanitizedPath, result as Buffer, { flag: "wx", mode: 0o600 });
    const inspection = new DatabaseSync(sanitizedPath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT owner FROM state_leases ORDER BY owner").all()).toEqual([
        { owner: "migration-owner" },
        { owner: "unrelated-gateway" },
        { owner: "unrelated-owner" },
      ]);
    } finally {
      inspection.close();
    }
  });

  it("refuses an unrecognized lease schema without changing the source database", () => {
    const sourcePath = databasePath();
    const source = new DatabaseSync(sourcePath);
    source.exec(
      "CREATE TABLE state_leases (scope TEXT); INSERT INTO state_leases VALUES ('gateway-owner');",
    );
    source.close();
    const original = readFileSync(sourcePath);
    expect(withoutOpenClawSqliteMachineAuthority(original)).toContain(
      "could not sanitize the OpenClaw state database",
    );
    expect(readFileSync(sourcePath)).toEqual(original);
  });
});
