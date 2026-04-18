// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only JSONL audit log for shields operations.
 *
 * Every shields-down/shields-up cycle is logged to
 * ~/.nemoclaw/state/shields-audit.jsonl for forensics and compliance.
 * Entries never contain credential values — only key names and policy labels.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir } from "./config-io";
import { redact } from "./runner";

const AUDIT_DIR = join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");
const AUDIT_FILE = join(AUDIT_DIR, "shields-audit.jsonl");

export interface ShieldsAuditEntry {
  action: "shields_down" | "shields_up" | "shields_auto_restore" | "shields_up_failed";
  sandbox: string;
  timestamp: string;
  timeout_seconds?: number;
  reason?: string;
  policy_applied?: string;
  policy_snapshot?: string;
  restored_at?: string;
  restored_by?: "operator" | "auto_timer";
  duration_seconds?: number;
  error?: string;
}

/**
 * Append a single audit entry as a JSON line. Creates the directory and file
 * on first write. The file is append-only — entries are never modified.
 */
export function appendAuditEntry(entry: ShieldsAuditEntry): void {
  ensureConfigDir(AUDIT_DIR);
  const safe = { ...entry };
  if (safe.reason) safe.reason = redact(safe.reason);
  if (safe.error) safe.error = redact(safe.error);
  appendFileSync(AUDIT_FILE, JSON.stringify(safe) + "\n", { mode: 0o600 });
}

export { AUDIT_FILE, AUDIT_DIR };
