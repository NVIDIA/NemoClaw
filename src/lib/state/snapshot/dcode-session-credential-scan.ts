// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { closeSync, constants, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  textContainsCredential,
  textContainsHighConfidenceCredential,
} from "../../security/credential-filter.js";

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

/** Inspect logical SQLite values so record framing cannot create token-shaped byte sequences. */
function databaseContainsCredential(
  databasePath: string,
  reportFailure: (reason: InspectionFailure) => void,
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
    const tables = database
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
      .all();
    for (const table of tables) {
      const tableName = typeof table.name === "string" ? table.name : null;
      if (!tableName) {
        reportFailure("table-name");
        return null;
      }
      if (typeof table.sql === "string" && textContainsHighConfidenceCredential(table.sql)) {
        return true;
      }
      for (const row of database
        .prepare(`SELECT * FROM ${sqliteIdentifier(tableName)}`)
        .iterate()) {
        for (const value of Object.values(row)) {
          if (
            (typeof value === "string" && textContainsCredential(value)) ||
            (value instanceof Uint8Array && sessionBlobContainsCredential(value))
          ) {
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

export function inspectExtractedDcodeSessionsDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void = () => {},
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
  return databaseContainsCredential(candidatePath, reportFailure);
}
