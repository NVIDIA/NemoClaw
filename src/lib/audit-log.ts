// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tamper-evident audit log with cryptographic hash chaining.
 *
 * Each log entry includes a SHA-256 hash of the previous entry, forming a
 * hash chain that makes modifications detectable. The log file is stored on
 * the **host** filesystem (outside the sandbox mount) and can optionally be
 * made append-only via chattr +a on Linux.
 *
 * Design goals (issue #799):
 *   - Append-only: entries cannot be modified after writing
 *   - Agent-proof: the agent cannot access or modify the log store
 *   - Tamper-evident: modifications are detectable via hash chain verification
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GENESIS is the well-known hash used as the "previous hash" for the first entry. */
export const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Default audit log directory on the host.
 * This path is intentionally outside the sandbox's writable filesystem.
 */
export function defaultAuditDir(): string {
  return join(homedir(), ".nemoclaw", "audit");
}

export function defaultAuditLogPath(): string {
  return join(defaultAuditDir(), "audit.jsonl");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Sequence number (0-indexed). */
  seq: number;
  /** SHA-256 hash of the previous entry's canonical JSON (or GENESIS_HASH for seq 0). */
  prev_hash: string;
  /** Category of event (e.g. "sandbox.create", "sandbox.destroy", "policy.add"). */
  event: string;
  /** Human-readable description. */
  message: string;
  /** The actor: "host" for CLI-driven actions, "system" for automated recovery. */
  actor: string;
  /** Optional structured metadata. */
  meta?: Record<string, unknown>;
  /** SHA-256 hash of this entry (computed over all fields above). */
  hash: string;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute the canonical hash for an entry. The hash covers every field
 * except hash itself, serialized as deep-sorted-key JSON so nested
 * objects (like meta) are included in the digest.
 */
export function computeEntryHash(entry: Omit<AuditEntry, "hash">): string {
  const canonical = JSON.stringify(deepSortKeys(entry));
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Recursively sort object keys so JSON.stringify produces a
 * deterministic string regardless of insertion order.
 */
function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Append a new audit entry to the log file, maintaining the hash chain.
 *
 * @param event   Event category (e.g. "sandbox.create")
 * @param message Human-readable description
 * @param opts    Optional: actor, meta, custom logPath
 * @returns       The written AuditEntry
 */
export function appendAuditEntry(
  event: string,
  message: string,
  opts: {
    actor?: string;
    meta?: Record<string, unknown>;
    logPath?: string;
  } = {},
): AuditEntry {
  const logPath = opts.logPath ?? defaultAuditLogPath();
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Serialize concurrent appends via an exclusive lock file.
  // Without this, two processes reading the last entry at the same
  // time would produce duplicate seq/prev_hash and corrupt the chain.
  // The lock is a separate file (<logPath>.lock) created with O_EXCL.
  const lockPath = logPath + ".lock";
  let lockFd: number | null = null;
  try {
    lockFd = acquireLockFile(lockPath);

    // Determine prev_hash and seq from the last line
    let prevHash = GENESIS_HASH;
    let seq = 0;

    if (existsSync(logPath)) {
      const lastEntry = readLastEntry(logPath);
      if (lastEntry) {
        prevHash = lastEntry.hash;
        seq = lastEntry.seq + 1;
      }
    }

    const partial: Omit<AuditEntry, "hash"> = {
      timestamp: new Date().toISOString(),
      seq,
      prev_hash: prevHash,
      event,
      message,
      actor: opts.actor ?? "host",
      ...(opts.meta ? { meta: opts.meta } : {}),
    };

    const hash = computeEntryHash(partial);
    const entry: AuditEntry = { ...partial, hash };

    // Append as a single JSONL line
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });

    // On Linux, attempt to set the append-only attribute.
    // This is best-effort: it requires root and the filesystem must support it.
    trySetAppendOnly(logPath);

    return entry;
  } finally {
    releaseLockFile(lockPath, lockFd);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read the last entry from the audit log without loading the entire file.
 * Returns null if the file is empty or does not exist.
 */
export function readLastEntry(logPath?: string): AuditEntry | null {
  const path = logPath ?? defaultAuditLogPath();
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const lines = content.trimEnd().split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  return JSON.parse(lines[lines.length - 1]) as AuditEntry;
}

/**
 * Read all entries from the audit log.
 * Throws AuditParseError on malformed JSONL instead of a raw SyntaxError
 * so callers (especially verifyAuditLog) can surface a clear diagnostic.
 */
export function readAllEntries(logPath?: string): AuditEntry[] {
  const path = logPath ?? defaultAuditLogPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const lines = content.trimEnd().split("\n").filter((l) => l.length > 0);
  const entries: AuditEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as AuditEntry);
    } catch {
      throw new AuditParseError(
        `Malformed JSONL at line ${i + 1}: ${lines[i].slice(0, 80)}`,
        i,
      );
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  totalEntries: number;
  /** Index of the first broken link, or -1 if chain is intact. */
  brokenAt: number;
  errors: string[];
}

/**
 * Walk the hash chain and verify every entry.
 *
 * Checks:
 *   1. Each entry's hash matches the recomputed hash of its contents
 *   2. Each entry's prev_hash matches the previous entry's hash
 *   3. The first entry's prev_hash is the GENESIS_HASH
 *   4. Sequence numbers are consecutive starting from 0
 */
export function verifyAuditLog(logPath?: string): VerifyResult {
  let entries: AuditEntry[];
  try {
    entries = readAllEntries(logPath);
  } catch (err) {
    const lineIndex = err instanceof AuditParseError ? err.lineIndex : 0;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      totalEntries: 0,
      brokenAt: lineIndex,
      errors: [msg],
    };
  }
  const result: VerifyResult = {
    valid: true,
    totalEntries: entries.length,
    brokenAt: -1,
    errors: [],
  };

  if (entries.length === 0) return result;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Check sequence number
    if (entry.seq !== i) {
      result.errors.push(
        "Entry " + i + ": expected seq=" + i + ", got seq=" + entry.seq,
      );
      markBroken(result, i);
    }

    // Check prev_hash
    const expectedPrev = i === 0 ? GENESIS_HASH : entries[i - 1].hash;
    if (entry.prev_hash !== expectedPrev) {
      result.errors.push(
        "Entry " + i + ": prev_hash mismatch (expected " + expectedPrev.slice(0, 16) + "..., got " + entry.prev_hash.slice(0, 16) + "...)",
      );
      markBroken(result, i);
    }

    // Recompute hash
    const { hash: _storedHash, ...rest } = entry;
    const recomputed = computeEntryHash(rest);
    if (entry.hash !== recomputed) {
      result.errors.push(
        "Entry " + i + ": hash mismatch (stored " + entry.hash.slice(0, 16) + "..., computed " + recomputed.slice(0, 16) + "...)",
      );
      markBroken(result, i);
    }
  }

  return result;
}

function markBroken(result: VerifyResult, index: number): void {
  result.valid = false;
  if (result.brokenAt === -1) {
    result.brokenAt = index;
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AuditParseError extends Error {
  constructor(message: string, public readonly lineIndex: number) {
    super(message);
    this.name = "AuditParseError";
  }
}

// ---------------------------------------------------------------------------
// File locking (serialize concurrent appends)
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * Acquire an exclusive lock file via O_EXCL (atomic create-or-fail).
 * Spins with a short sleep until the lock is acquired or the timeout
 * is reached, at which point it force-removes the stale lock and
 * retries once.
 */
function acquireLockFile(lockPath: string): number {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        // Stale lock — force-remove and retry once
        try { unlinkSync(lockPath); } catch { /* ignore */ }
        return openSync(lockPath, "wx", 0o600);
      }
      // Busy-wait with a short sleep
      const wait = Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now());
      if (wait > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  }
}

function releaseLockFile(lockPath: string, fd: number | null): void {
  if (fd !== null) {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Append-only protection (Linux chattr +a)
// ---------------------------------------------------------------------------

/**
 * Attempt to set the append-only attribute on a file via chattr +a.
 * This is best-effort: it silently fails on non-Linux, non-ext4, or without root.
 */
export function trySetAppendOnly(filePath: string): boolean {
  if (platform() !== "linux") return false;

  try {
    execFileSync("chattr", ["+a", filePath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    // Expected to fail without root or on unsupported filesystems
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI helper for nemoclaw verify-audit
// ---------------------------------------------------------------------------

/**
 * Run verify and print results to stdout. Returns process exit code.
 */
export function runVerifyAudit(args: string[] = []): number {
  const logPath = args.find((a) => !a.startsWith("-")) ?? defaultAuditLogPath();

  if (!existsSync(logPath)) {
    console.log("  No audit log found at: " + logPath);
    console.log("  Nothing to verify.");
    return 0;
  }

  const result = verifyAuditLog(logPath);

  if (result.totalEntries === 0) {
    console.log("  Audit log is empty.");
    return 0;
  }

  if (result.valid) {
    console.log("  Audit log integrity: OK");
    console.log("  Entries verified: " + result.totalEntries);
    console.log("  Hash chain: intact");
    return 0;
  }

  console.error("  Audit log integrity: FAILED");
  console.error("  Entries checked: " + result.totalEntries);
  console.error("  First broken link at entry: " + result.brokenAt);
  console.error("");
  for (const err of result.errors) {
    console.error("  - " + err);
  }
  return 1;
}
