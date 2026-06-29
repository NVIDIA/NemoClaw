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

import { appendFileSync, readFileSync } from "node:fs";
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

/**
 * Scan the audit log in reverse and return details about the most recent
 * `shields_auto_restore` event for the given sandbox that falls within
 * `withinMs` milliseconds of now. Also reads the preceding `shields_down`
 * entry to recover the original timeout so callers can echo it back.
 *
 * Returns null when no matching entry is found OR when the file is unreadable.
 * Fail-open is intentional: blocking agent dispatch on audit I/O errors (e.g.
 * EACCES, EIO) would be a DoS vector — callers must treat null as "no warning"
 * rather than "no event." Future-dated entries are rejected as a clock-skew
 * defense so a crafted entry cannot pin the warning permanently.
 *
 * File-size note: the audit file is user-owned and written only by NemoClaw at
 * ~200 bytes per entry. An unbounded readFileSync is acceptable for this
 * warning-only path; add a size cap if the audit log gains a rotation policy.
 *
 * The optional `auditFile` parameter overrides the default path; used in tests.
 */
export function readRecentShieldsAutoRestore(
  sandboxName: string,
  withinMs: number,
  auditFile: string = AUDIT_FILE,
): ShieldsAutoRestoreEvent | null {
  let content: string;
  try {
    content = readFileSync(auditFile, "utf8");
  } catch {
    return null;
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
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseEntry(lines[i]);
    if (
      entry?.action !== "shields_auto_restore" ||
      entry.sandbox !== sandboxName ||
      typeof entry.timestamp !== "string"
    )
      continue;
    const restoreMs = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(restoreMs) || restoreMs < cutoff || restoreMs > now) continue;
    const restoreTs = entry.timestamp;
    // Continue backwards to find the preceding shields_down to get timeout_seconds.
    let timeoutSeconds: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = parseEntry(lines[j]);
      if (prev?.action === "shields_down" && prev.sandbox === sandboxName) {
        if (
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
    return { timestamp: restoreTs, timeoutSeconds };
  }
  return null;
}

export { AUDIT_FILE, AUDIT_DIR };
