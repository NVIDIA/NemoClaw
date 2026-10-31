// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { closeSync, constants, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { textContainsCredential } from "../../security/credential-filter.js";

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sessionBlobContainsCredential(value: Uint8Array): boolean {
  // quickjs-rs 0.2.5 checkpoints include this NUL-delimited engine diagnostic.
  // Its printf format is public code, not a token assignment. Normalize only
  // that exact constant; scan the rest of the interpreter memory as before.
  const text = Buffer.from(value)
    .toString("utf8")
    .replaceAll("\0unexpected token: '%.*s'\0", "\0unexpected syntax: '%.*s'\0");
  return textContainsCredential(text);
}

type InspectionFailure = "integrity-check" | "table-name" | "sqlite-query" | "file-access";
type DatabaseKind = "dcode" | "openclaw";

function cellContainsCredential(
  databaseKind: DatabaseKind,
  tableName: string,
  columnName: string,
  value: unknown,
): boolean {
  if (value instanceof Uint8Array) {
    return databaseKind === "dcode"
      ? sessionBlobContainsCredential(value)
      : textContainsCredential(Buffer.from(value).toString("utf8"));
  }
  if (typeof value !== "string") return false;
  // OpenClaw 2026.9.2 records a truncated identity hash in these ledger columns.
  // The public migration name ends in "keys", but the value is not a credential assignment.
  if (
    databaseKind === "openclaw" &&
    ((tableName === "migration_runs" && columnName === "id") ||
      (tableName === "migration_sources" && columnName === "last_run_id")) &&
    /^legacy-main-session-keys:[a-f0-9]{24}$/u.test(value)
  ) {
    return false;
  }
  return textContainsCredential(value);
}

/** Inspect logical SQLite values so record framing cannot create token-shaped byte sequences. */
function databaseContainsCredential(
  databasePath: string,
  reportFailure: (reason: InspectionFailure) => void,
  databaseKind: DatabaseKind,
): boolean | null {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      readOnly: true,
      timeout: 2_000,
    });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const integrity = database.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      reportFailure("integrity-check");
      return null;
    }
    const schema = database.prepare("SELECT type, name, sql FROM sqlite_schema").all();
    for (const table of schema) {
      if (
        (typeof table.name === "string" && textContainsCredential(table.name)) ||
        (typeof table.sql === "string" && textContainsCredential(table.sql))
      ) {
        return true;
      }
      if (table.type !== "table") continue;
      const tableName = typeof table.name === "string" ? table.name : null;
      if (!tableName) {
        reportFailure("table-name");
        return null;
      }
      for (const row of database
        .prepare(`SELECT * FROM ${sqliteIdentifier(tableName)}`)
        .iterate()) {
        for (const [columnName, value] of Object.entries(row)) {
          if (cellContainsCredential(databaseKind, tableName, columnName, value)) {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    reportFailure("sqlite-query");
    return null;
  } finally {
    database?.close();
  }
}

function inspectExtractedDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void,
  databaseKind: DatabaseKind,
): boolean | null {
  const candidatePath = path.resolve(scanRoot, entry);
  if (!isWithinRoot(candidatePath, scanRoot)) {
    reportFailure("file-access");
    return null;
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      reportFailure("file-access");
      return null;
    }
  } catch {
    reportFailure("file-access");
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return databaseContainsCredential(candidatePath, reportFailure, databaseKind);
}

export function inspectExtractedDcodeSessionsDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void = () => {},
): boolean | null {
  return inspectExtractedDatabase(scanRoot, entry, reportFailure, "dcode");
}

export function inspectExtractedOpenClawDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void = () => {},
): boolean | null {
  return inspectExtractedDatabase(scanRoot, entry, reportFailure, "openclaw");
}
