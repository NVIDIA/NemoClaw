// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { textContainsHighConfidenceCredential } from "../../security/credential-filter.js";
import { sanitizeMachineLocalArchiveConfig } from "../sandbox.js";

describe("native OpenClaw SQLite archive sanitation", () => {
  it.each([".openclaw", ".openclaw-data"])(
    "sanitizes the %s database member while leaving the live database unchanged",
    (stateDirectory) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-sqlite-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const databasePath = path.join(nativeRoot, stateDirectory, "state", "openclaw.sqlite");
        const archivePath = path.join(fixture, "native-home.tar");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        CREATE TABLE device_identities (identity_key TEXT PRIMARY KEY, private_key_pem TEXT);
        CREATE TABLE session_state (session_id TEXT PRIMARY KEY, summary TEXT);
        INSERT INTO session_state VALUES ('session-1', 'keep me');
      `);
        const begin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
        const end = ["-----END", "PRIVATE KEY-----"].join(" ");
        database
          .prepare("INSERT INTO device_identities VALUES (?, ?)")
          .run("primary", `${begin}\nmachine-private-key\n${end}`);
        database.close();
        expect(spawnSync("tar", ["-cf", archivePath, "-C", nativeRoot, "."]).status).toBe(0);

        expect(sanitizeMachineLocalArchiveConfig(archivePath)).toBeNull();

        const extracted = path.join(fixture, "extracted");
        fs.mkdirSync(extracted);
        expect(spawnSync("tar", ["-xf", archivePath, "-C", extracted]).status).toBe(0);
        const archivedPath = path.join(extracted, stateDirectory, "state", "openclaw.sqlite");
        const archived = new DatabaseSync(archivedPath, { readOnly: true });
        expect(archived.prepare("SELECT COUNT(*) AS count FROM device_identities").get()).toEqual({
          count: 0,
        });
        expect(archived.prepare("SELECT * FROM session_state").get()).toEqual({
          session_id: "session-1",
          summary: "keep me",
        });
        archived.close();
        expect(textContainsHighConfidenceCredential(fs.readFileSync(archivedPath, "utf8"))).toBe(
          false,
        );
        const live = new DatabaseSync(databasePath, { readOnly: true });
        expect(live.prepare("SELECT COUNT(*) AS count FROM device_identities").get()).toEqual({
          count: 1,
        });
        live.close();
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [".openclaw", "-wal"],
    [".openclaw", "-shm"],
    [".openclaw", "-journal"],
    [".openclaw-data", "-wal"],
    [".openclaw-data", "-shm"],
    [".openclaw-data", "-journal"],
  ])(
    "rejects an archived %s database%s companion before it can replay authority",
    (stateDirectory, suffix) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-sqlite-sidecar-"));
      try {
        const nativeRoot = path.join(fixture, "native-home");
        const stateRoot = path.join(nativeRoot, stateDirectory, "state");
        const archivePath = path.join(fixture, "native-home.tar");
        fs.mkdirSync(stateRoot, { recursive: true });
        fs.writeFileSync(path.join(stateRoot, `openclaw.sqlite${suffix}`), "machine-authority");
        expect(spawnSync("tar", ["-cf", archivePath, "-C", nativeRoot, "."]).status).toBe(0);

        expect(sanitizeMachineLocalArchiveConfig(archivePath)).toContain(
          "transient OpenClaw database companion",
        );
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
