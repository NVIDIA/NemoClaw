// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MACHINE_AUTHORITY_TABLES_TO_CLEAR = [
  "apns_registration_tombstones",
  "apns_registrations",
  "audit_identity_keys",
  "channel_pairing_requests",
  "config_revision_keys",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "device_identities",
  "device_pair_setup_completions",
  "device_pairing_join_codes",
  "device_pairing_pending",
  "gateway_origin_device_tokens",
  "mcp_oauth_stores",
  "native_hook_relay_bridges",
  "secret_store_entries",
  "web_push_subscriptions",
] as const;

const MACHINE_AUTHORITY_COLUMN_UPDATES = [
  {
    table: "channel_ingress_events",
    statement:
      "UPDATE channel_ingress_events SET claim_token = NULL, claim_owner = NULL, claimed_at = NULL WHERE claim_token IS NOT NULL",
  },
  {
    table: "device_pairing_paired",
    statement: "UPDATE device_pairing_paired SET tokens_json = NULL WHERE tokens_json IS NOT NULL",
  },
] as const;

/** Remove local authority from an archive copy without changing its tar member size. */
export function withoutOpenClawSqliteMachineAuthority(payload: Buffer): Buffer | string {
  if (!payload.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"))) {
    return "the OpenClaw state database is not a SQLite database";
  }
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-state-"));
  const databasePath = path.join(temporaryDirectory, "openclaw.sqlite");
  let database: DatabaseSync | null = null;
  try {
    writeFileSync(databasePath, payload, { mode: 0o600 });
    database = new DatabaseSync(databasePath, { allowExtension: false, timeout: 2_000 });
    database.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF; PRAGMA secure_delete = ON; BEGIN IMMEDIATE;",
    );
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of MACHINE_AUTHORITY_TABLES_TO_CLEAR) {
      if (tables.has(table)) database.exec(`DELETE FROM ${table}`);
    }
    for (const { table, statement } of MACHINE_AUTHORITY_COLUMN_UPDATES) {
      if (tables.has(table)) database.exec(statement);
    }
    database.exec("COMMIT;");
    database.close();
    database = null;
    const sanitized = readFileSync(databasePath);
    if (sanitized.byteLength !== payload.byteLength) {
      return "the OpenClaw state database changed size while removing machine-local authority";
    }
    return sanitized;
  } catch (error) {
    try {
      database?.exec("ROLLBACK;");
    } catch {
      // Preserve the primary sanitation failure.
    }
    return `could not sanitize the OpenClaw state database: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    database?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
