// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only JSONL audit log for operator-initiated configuration changes.
 *
 * This log is independent of any sandbox immutability feature. It records only
 * the mutation class, sandbox, timestamp, and a redacted non-secret reason.
 */

import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { redactFull } from "../../security/redact";
import { ensureConfigDir } from "../config-io";
import { resolveNemoclawStateDir } from "../paths";

const OPERATIONAL_AUDIT_DIR = resolveNemoclawStateDir();
const OPERATIONAL_AUDIT_FILE = join(OPERATIONAL_AUDIT_DIR, "operational-audit.jsonl");
const MAX_OPERATIONAL_AUDIT_READ_BYTES = 8 * 1024 * 1024;

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

/** Read one stable audit snapshot without following a replaced or linked file. */
export function readStableOperationalAudit(filePath = OPERATIONAL_AUDIT_FILE): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("audit path is not a regular file");
    if (before.size > BigInt(MAX_OPERATIONAL_AUDIT_READ_BYTES)) {
      throw new Error("config audit exceeds the bounded 8 MiB rebuild capture limit");
    }
    const buffer = Buffer.alloc(Number(before.size));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytesRead !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("config audit changed during rebuild capture");
    }
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export { OPERATIONAL_AUDIT_DIR, OPERATIONAL_AUDIT_FILE };
