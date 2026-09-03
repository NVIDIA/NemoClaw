// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only JSONL audit log for operator-initiated configuration changes.
 *
 * This log is independent of any sandbox immutability feature. It records only
 * the mutation class, sandbox, timestamp, and a redacted non-secret reason.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { redactFull } from "../../security/redact";
import { ensureConfigDir } from "../config-io";
import { resolveNemoclawStateDir } from "../paths";

const OPERATIONAL_AUDIT_DIR = resolveNemoclawStateDir();
const OPERATIONAL_AUDIT_FILE = join(OPERATIONAL_AUDIT_DIR, "operational-audit.jsonl");

export interface OperationalAuditEntry {
  readonly action: "inference_set" | "config_set" | "rotate_token";
  readonly sandbox: string;
  readonly timestamp: string;
  readonly reason?: string;
}

/** Append one private, redacted operational event without modifying prior rows. */
export function appendAuditEntry(entry: OperationalAuditEntry): void {
  ensureConfigDir(OPERATIONAL_AUDIT_DIR);
  const safe: OperationalAuditEntry = {
    action: entry.action,
    sandbox: entry.sandbox,
    timestamp: entry.timestamp,
    ...(entry.reason === undefined ? {} : { reason: redactFull(entry.reason) }),
  };
  appendFileSync(OPERATIONAL_AUDIT_FILE, `${JSON.stringify(safe)}\n`, {
    mode: 0o600,
  });
}

export { OPERATIONAL_AUDIT_DIR, OPERATIONAL_AUDIT_FILE };
