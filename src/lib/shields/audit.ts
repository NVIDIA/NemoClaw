// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only JSONL audit log for shields and operational events.
 *
 * Records shields lifecycle actions (up, down, auto-restore) and config
 * mutations (inference-set, config-set, token rotation) to
 * ~/.nemoclaw/state/shields-audit.jsonl for forensics and compliance.
 * Entries never contain credential values — only key names and policy labels.
 */

import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { redactFull } from "../security/redact";
import { ensureConfigDir } from "../state/config-io";
import { resolveNemoclawStateDir } from "../state/paths";

const AUDIT_DIR = resolveNemoclawStateDir();
const AUDIT_FILE = join(AUDIT_DIR, "shields-audit.jsonl");

export interface ShieldsAuditEntry {
  action:
    | "shields_down"
    | "shields_up"
    | "shields_auto_restore"
    | "shields_up_failed"
    | "shields_auto_restore_lock_warning"
    | "inference_set"
    | "config_set"
    | "rotate_token";
  sandbox: string;
  timestamp: string;
  timeout_seconds?: number;
  reason?: string;
  policy_applied?: string;
  policy_snapshot?: string;
  restored_at?: string;
  scheduled_restore_at?: string;
  restored_by?: "operator" | "auto_timer";
  duration_seconds?: number;
  error?: string;
  warning?: string;
  lock_verified?: boolean;
}

/**
 * Append a single audit entry as a JSON line. Creates the directory and file
 * on first write. The file is append-only — entries are never modified.
 */
export function appendAuditEntry(entry: ShieldsAuditEntry): void {
  ensureConfigDir(AUDIT_DIR);
  const safe = { ...entry };
  if (safe.reason) safe.reason = redactFull(safe.reason);
  if (safe.error) safe.error = redactFull(safe.error);
  appendFileSync(AUDIT_FILE, JSON.stringify(safe) + "\n", { mode: 0o600 });
}

export interface ShieldsAutoRestoreEvent {
  /** ISO timestamp written by the auto-restore timer. */
  timestamp: string;
  /**
   * Original timeout in seconds from the preceding `shields_down` entry, or
   * null when that entry is not found in the audit log.
   */
  timeoutSeconds: number | null;
}

export type ShieldsAutoRestoreReadResult =
  | { kind: "event"; event: ShieldsAutoRestoreEvent }
  | { kind: "none" }
  | { kind: "unreadable" };

const MAX_RECENT_AUDIT_BYTES = 1024 * 1024;

function readAuditTail(auditFile: string): string {
  const fd = openSync(auditFile, "r");
  try {
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, MAX_RECENT_AUDIT_BYTES);
    if (bytesToRead === 0) return "";

    const offset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset === 0) return content;

    // The bounded read can begin in the middle of a JSONL entry. Drop that
    // partial first line and retain only complete entries from the tail. If
    // there is no newline, an oversized unterminated entry has consumed the
    // entire tail; report degraded visibility instead of treating it as an
    // empty audit log.
    const firstNewline = content.indexOf("\n");
    if (firstNewline === -1) throw new Error("audit JSONL entry exceeds bounded tail");
    return content.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan the audit log in reverse and return details about the most recent
 * `shields_auto_restore` event for the given sandbox that falls within
 * `withinMs` milliseconds of now. Also reads the preceding `shields_down`
 * entry to recover the original timeout so callers can echo it back.
 *
 * This log is non-authoritative UX input. Missing, corrupt, or locally tampered
 * rows must never make policy or current shield-state decisions; callers use an
 * `event` result only to explain a likely relock. Current state is queried by
 * the shields commands themselves.
 *
 * Missing files return `none`. Other read failures return `unreadable` so the
 * caller can surface degraded audit visibility while still dispatching the
 * agent. Fail-open is intentional: blocking dispatch on EACCES/EIO would turn
 * this advisory check into a denial-of-service boundary. Future-dated entries
 * are rejected strictly so a crafted row cannot pin the warning permanently;
 * the same host clock writes and reads this local log, and a rare false
 * negative after a backward clock adjustment is safer than stale guidance.
 *
 * Only the last 1 MiB is read. This intentionally keeps the one-shot CLI read
 * synchronous so the warning is ordered before dispatch while bounding the
 * work to thousands of normal audit entries. If the matching `shields_down`
 * row falls outside that tail, the event remains useful with a null timeout
 * and the caller uses its safe fallback suggestion. Revisit the synchronous
 * API if audit storage moves off the local filesystem or into a long-lived
 * process.
 *
 * Remove this reader when OpenClaw exposes a structured relock cause or when
 * extend-on-activity removes the mid-session relock condition.
 *
 * The optional `auditFile` parameter overrides the default path; used in tests.
 */
export function readRecentShieldsAutoRestore(
  sandboxName: string,
  withinMs: number,
  auditFile: string = AUDIT_FILE,
): ShieldsAutoRestoreReadResult {
  if (!Number.isFinite(withinMs) || withinMs <= 0) return { kind: "none" };

  let content: string;
  try {
    content = readAuditTail(auditFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable" };
  }
  const cutoff = Date.now() - withinMs;
  const lines = content.split("\n");

  function parseEntry(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Intentional resilient skip: a malformed or truncated JSONL line (e.g.
      // from a partial write or manual edit) must not prevent finding valid
      // surrounding entries. The reverse scan continues past it.
    }
    return null;
  }

  const now = Date.now();
  // Scan backwards for the most recent shields_auto_restore within the window.
  // A later shields_down for the same sandbox makes older relock context stale,
  // but remains advisory: it suppresses only this warning and never establishes
  // current shield state.
  let newerShieldsDownMs: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseEntry(lines[i]);
    if (entry?.sandbox !== sandboxName) continue;
    if (entry.action === "shields_down") {
      const downMs =
        typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : Number.NaN;
      if (Number.isFinite(downMs) && downMs <= now) {
        newerShieldsDownMs = Math.max(newerShieldsDownMs ?? downMs, downMs);
      }
      continue;
    }
    if (entry?.action !== "shields_auto_restore" || typeof entry.timestamp !== "string") continue;
    const restoreMs = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(restoreMs) || restoreMs < cutoff || restoreMs > now) continue;
    if (newerShieldsDownMs !== null && newerShieldsDownMs >= restoreMs) {
      return { kind: "none" };
    }
    const restoreTs = entry.timestamp;
    // Continue backwards to find the preceding shields_down to get timeout_seconds.
    let timeoutSeconds: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = parseEntry(lines[j]);
      if (prev?.action === "shields_down" && prev.sandbox === sandboxName) {
        const downMs =
          typeof prev.timestamp === "string" ? new Date(prev.timestamp).getTime() : Number.NaN;
        if (
          Number.isFinite(downMs) &&
          downMs <= restoreMs &&
          typeof prev.timeout_seconds === "number" &&
          Number.isFinite(prev.timeout_seconds) &&
          Number.isInteger(prev.timeout_seconds) &&
          prev.timeout_seconds >= 1 &&
          prev.timeout_seconds <= 1800
        ) {
          timeoutSeconds = prev.timeout_seconds;
        }
        break;
      }
    }
    return { kind: "event", event: { timestamp: restoreTs, timeoutSeconds } };
  }
  return { kind: "none" };
}

export { AUDIT_DIR, AUDIT_FILE };
