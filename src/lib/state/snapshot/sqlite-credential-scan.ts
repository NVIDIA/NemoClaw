// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { closeSync, constants, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  credentialFindingRule,
  redactCredentialText,
  type CredentialFindingRule,
} from "../../security/credential-filter.js";

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export const DCODE_QUICKJS_DIAGNOSTIC = "\0unexpected token: '%.*s'\0";

export function normalizeDcodeSessionDiagnostic(text: string): string {
  // quickjs-rs 0.2.5 checkpoints include this NUL-delimited engine diagnostic.
  // Its printf format is public code, not a token assignment. Normalize only
  // that exact constant; scan the rest of the interpreter memory as before.
  // Leave the closing NUL available as the next diagnostic's opening delimiter.
  return text.replace(/\0unexpected token: '%\.\*s'(?=\0)/gu, "\0unexpected syntax: '%.*s'");
}

type InspectionFailure = "integrity-check" | "table-name" | "sqlite-query" | "file-access";
type DatabaseKind = "dcode" | "openclaw";

export interface SqliteCredentialFinding {
  rule: CredentialFindingRule;
  threadId?: string;
}

// Only native session tables can attribute a finding to a conversation.
const DCODE_THREAD_TABLES = new Set([
  "checkpoints",
  "writes",
  "dcode_thread_names",
  "dcode_thread_workspaces",
  "dcode_workspace_snapshots",
  "dcode_btw_costs",
]);

function safeThreadId(table: string, value: unknown): string | undefined {
  return DCODE_THREAD_TABLES.has(table) &&
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : undefined;
}

function cellCredentialRule(
  databaseKind: DatabaseKind,
  tableName: string,
  columnName: string,
  value: unknown,
): CredentialFindingRule | null {
  if (value instanceof Uint8Array) {
    return databaseKind === "dcode"
      ? credentialFindingRule(
          normalizeDcodeSessionDiagnostic(Buffer.from(value).toString("utf8")),
          {
            sqlBindParameters: true,
          },
        )
      : credentialFindingRule(Buffer.from(value).toString("utf8"));
  }
  if (typeof value !== "string") return null;
  // OpenClaw 2026.9.2 records a truncated identity hash in these ledger columns.
  // The public migration name ends in "keys", but the value is not a credential assignment.
  if (
    databaseKind === "openclaw" &&
    ((tableName === "migration_runs" && columnName === "id") ||
      (tableName === "migration_sources" && columnName === "last_run_id")) &&
    /^legacy-main-session-keys:[a-f0-9]{24}$/u.test(value)
  ) {
    return null;
  }
  return credentialFindingRule(value, { sqlBindParameters: databaseKind === "dcode" });
}

/** Inspect logical SQLite values so record framing cannot create token-shaped byte sequences. */
function databaseContainsCredential(
  databasePath: string,
  reportFailure: (reason: InspectionFailure) => void,
  databaseKind: DatabaseKind,
  reportFinding: (finding: SqliteCredentialFinding) => void,
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
      const schemaRule =
        (typeof table.name === "string" && credentialFindingRule(table.name)) ||
        (typeof table.sql === "string" && credentialFindingRule(table.sql));
      if (schemaRule) {
        reportFinding({ rule: schemaRule });
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
          const rule = cellCredentialRule(databaseKind, tableName, columnName, value);
          if (rule) {
            const threadId =
              databaseKind === "dcode" ? safeThreadId(tableName, row.thread_id) : undefined;
            reportFinding({ rule, ...(threadId ? { threadId } : {}) });
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
  reportFinding: (finding: SqliteCredentialFinding) => void,
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
  return databaseContainsCredential(candidatePath, reportFailure, databaseKind, reportFinding);
}

export function inspectExtractedDcodeSessionsDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void = () => {},
  reportFinding: (finding: SqliteCredentialFinding) => void = () => {},
): boolean | null {
  return inspectExtractedDatabase(scanRoot, entry, reportFailure, "dcode", reportFinding);
}

export function inspectExtractedOpenClawDatabase(
  scanRoot: string,
  entry: string,
  reportFailure: (reason: InspectionFailure) => void = () => {},
): boolean | null {
  return inspectExtractedDatabase(scanRoot, entry, reportFailure, "openclaw", () => {});
}

export type NativeScanDiagnostic =
  | { kind: "credential-content"; finding?: SqliteCredentialFinding }
  | {
      kind: "sqlite-inspection";
      reason: "integrity-check" | "table-name" | "sqlite-query" | "file-access";
    }
  | { kind: "extraction" | "archive-inspection" | "deadline-expiry" };

export function formatDcodeScanDiagnostic(entry: string, diagnostic: NativeScanDiagnostic): string {
  const location = JSON.stringify(redactCredentialText(entry).slice(0, 240));
  const recovery =
    "See https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/manage-sandboxes/operate-sandboxes/recover-and-rebuild-sandboxes#resolve-a-deep-agents-code-backup-refusal";
  if (diagnostic.kind === "deadline-expiry") {
    return `Native archive credential scan exceeded the backup deadline (category: deadline-expiry) at ${location}. Conversation identification unavailable. ${recovery}`;
  }
  if (diagnostic.kind === "credential-content") {
    const finding = diagnostic.finding;
    const conversation = finding?.threadId
      ? `First affected conversation: ${finding.threadId}. Inspect it in Deep Agents Code; if you choose to discard it, close its active clients and use native thread deletion. Deletion loses that conversation and may not clear every backup finding.`
      : "Conversation identification unavailable.";
    return `Native state archive contains credential-bearing content at ${location} (rule: ${finding?.rule ?? "credential-content"}). ${conversation} Only the first finding is reported. ${recovery}`;
  }
  const category =
    diagnostic.kind === "sqlite-inspection"
      ? `SQLite inspection failed (${diagnostic.reason})`
      : diagnostic.kind === "extraction"
        ? "Archive extraction failed"
        : "Archive inspection failed";
  return `${category} at ${location}; credential status could not be established. Conversation identification unavailable. ${recovery}`;
}
