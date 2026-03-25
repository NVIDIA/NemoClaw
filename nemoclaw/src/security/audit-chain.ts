// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tamper-evident audit chain logger.
 *
 * Each log entry includes a SHA-256 hash of its payload and the hash of the
 * previous entry, forming a hash chain. Any modification to an entry or its
 * ordering is detectable by verifying the chain.
 *
 * Entry format (one JSON object per line):
 *   { seq, chain_id, prev_hash, entry_hash, type, time, data }
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Public types ─────────────────────────────────────────────

/** A single audit log entry as persisted in JSONL. */
export interface AuditEntry {
  readonly seq: number;
  readonly chain_id: string;
  readonly prev_hash: string;
  readonly entry_hash: string;
  readonly type: string;
  readonly time: string;
  readonly data: unknown;
}

/** Result returned by `verifyChain`. */
export interface VerifyResult {
  readonly valid: boolean;
  readonly entries: number;
  readonly error?: string;
}

// ── Internal types ───────────────────────────────────────────

/** Payload used to compute the entry hash (all fields except entry_hash). */
interface LogPayload {
  seq: number;
  chain_id: string;
  prev_hash: string;
  type: string;
  time: string;
  data: unknown;
}

// ── AuditLogger class ────────────────────────────────────────

/**
 * Append-only audit logger that writes hash-chained JSONL entries.
 *
 * Construct with a file path. The logger creates parent directories as
 * needed and resumes the chain if the file already contains entries.
 */
export class AuditLogger {
  private readonly path: string;
  private seq: number;
  private prevHash: string;
  private readonly chainId: string;

  constructor(path: string) {
    if (!path || typeof path !== "string") {
      throw new Error("AuditLogger requires a non-empty file path");
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const tail = readTailState(path);
    this.path = path;
    this.seq = tail.seq;
    this.prevHash = tail.prevHash;
    this.chainId = tail.chainId || randomChainId();
  }

  /** Append a new audit entry. */
  log(type: string, data: unknown): void {
    if (!type || typeof type !== "string") {
      throw new Error("log() requires a non-empty type string");
    }

    const nextSeq = this.seq + 1;
    const now = new Date().toISOString();

    const payload: LogPayload = {
      seq: nextSeq,
      chain_id: this.chainId,
      prev_hash: this.prevHash,
      type,
      time: now,
      data,
    };

    const entryHash = computeEntryHash(payload);

    const entry: AuditEntry = {
      seq: nextSeq,
      chain_id: this.chainId,
      prev_hash: this.prevHash,
      entry_hash: entryHash,
      type,
      time: now,
      data,
    };

    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
    this.seq = nextSeq;
    this.prevHash = entryHash;
  }
}

// ── Standalone functions ─────────────────────────────────────

/**
 * Verify the integrity of an audit chain file.
 *
 * Reads every JSONL line, recomputes each entry hash, and confirms that
 * `prev_hash` links form an unbroken chain. Returns a result object
 * indicating whether the chain is valid.
 *
 * Returns `{ valid: true, entries: 0 }` for empty or nonexistent files.
 */
export function verifyChain(path: string): VerifyResult {
  if (!path || typeof path !== "string") {
    return { valid: false, entries: 0, error: "path is required" };
  }

  if (!existsSync(path)) {
    return { valid: true, entries: 0 };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, entries: 0, error: `failed to read file: ${message}` };
  }

  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return { valid: true, entries: 0 };
  }

  let lastHash = "";
  let count = 0;
  let expectedSeq = 1;
  let chainId = "";

  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]) as AuditEntry;
    } catch {
      return {
        valid: false,
        entries: count,
        error: `malformed JSON at line ${String(i + 1)}`,
      };
    }

    // Verify sequence numbers are contiguous (1, 2, 3, ...).
    if (entry.seq !== expectedSeq) {
      return {
        valid: false,
        entries: count,
        error: `sequence gap at seq ${String(entry.seq)}: expected ${String(expectedSeq)}`,
      };
    }

    // Verify chain_id is consistent across all entries.
    if (i === 0) {
      chainId = entry.chain_id;
    } else if (entry.chain_id !== chainId) {
      return {
        valid: false,
        entries: count,
        error: `chain_id mismatch at seq ${String(entry.seq)}: expected "${chainId}", got "${entry.chain_id}"`,
      };
    }

    // Verify prev_hash links to the previous entry's entry_hash.
    if (entry.prev_hash !== lastHash) {
      return {
        valid: false,
        entries: count,
        error: `prev_hash mismatch at seq ${String(entry.seq)} (line ${String(i + 1)})`,
      };
    }

    // Reconstruct the payload (all fields except entry_hash) and recompute.
    const payload: LogPayload = {
      seq: entry.seq,
      chain_id: entry.chain_id,
      prev_hash: entry.prev_hash,
      type: entry.type,
      time: entry.time,
      data: entry.data,
    };

    const expectedHash = computeEntryHash(payload);
    if (entry.entry_hash !== expectedHash) {
      return {
        valid: false,
        entries: count,
        error: `entry_hash mismatch at seq ${String(entry.seq)} (line ${String(i + 1)})`,
      };
    }

    lastHash = entry.entry_hash;
    count++;
    expectedSeq++;
  }

  return { valid: true, entries: count };
}

/**
 * Export audit entries with `seq >= since`, up to `limit`.
 *
 * If `limit` is 0 or omitted, all matching entries are returned.
 * Malformed lines are silently skipped.
 */
export function exportEntries(path: string, since: number, limit?: number): AuditEntry[] {
  if (!path || typeof path !== "string") {
    throw new Error("exportEntries requires a non-empty file path");
  }
  if (typeof since !== "number" || !Number.isFinite(since)) {
    throw new Error("since must be a finite number");
  }

  if (!existsSync(path)) {
    return [];
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const result: AuditEntry[] = [];
  const effectiveLimit = limit != null && limit > 0 ? limit : 0;

  for (const line of lines) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      // Skip malformed lines.
      continue;
    }

    if (entry.seq < since) {
      continue;
    }

    result.push(entry);

    if (effectiveLimit > 0 && result.length >= effectiveLimit) {
      break;
    }
  }

  return result;
}

/**
 * Return the last `n` entries from an audit file.
 *
 * Defaults to 50 when `n` is omitted or non-positive.
 * Malformed lines are silently skipped.
 */
export function tailEntries(path: string, n?: number): AuditEntry[] {
  if (!path || typeof path !== "string") {
    throw new Error("tailEntries requires a non-empty file path");
  }

  const effectiveN = n != null && n > 0 ? n : 50;

  if (!existsSync(path)) {
    return [];
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const entries: AuditEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Skip malformed lines.
      continue;
    }
  }

  if (entries.length <= effectiveN) {
    return entries;
  }

  return entries.slice(entries.length - effectiveN);
}

// ── Internal helpers ─────────────────────────────────────────

/** Compute the SHA-256 hash of a log payload. */
// NOTE: Hash computation uses JSON.stringify which preserves insertion-order
// key ordering within a single Node.js runtime. Cross-runtime verification
// (e.g., Go, Python) requires a canonical JSON serialization (RFC 8785).
// This module's verification is only guaranteed within Node.js environments.
function computeEntryHash(payload: LogPayload): string {
  const json = JSON.stringify(payload);
  const hash = createHash("sha256").update(json, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

/** Generate a random 24-character hex chain ID (12 random bytes). */
function randomChainId(): string {
  return randomBytes(12).toString("hex");
}

interface TailState {
  seq: number;
  prevHash: string;
  chainId: string;
}

/** Read the last entry's state from an existing audit file. */
function readTailState(path: string): TailState {
  if (!existsSync(path)) {
    return { seq: 0, prevHash: "", chainId: "" };
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");

  let lastSeq = 0;
  let lastHash = "";
  let lastChainId = "";

  for (const line of lines) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      // Skip malformed lines and continue with the last successfully parsed entry.
      console.error(`readTailState: skipping malformed line in ${path}`);
      continue;
    }
    lastSeq = entry.seq;
    lastHash = entry.entry_hash;
    lastChainId = entry.chain_id;
  }

  return { seq: lastSeq, prevHash: lastHash, chainId: lastChainId };
}
