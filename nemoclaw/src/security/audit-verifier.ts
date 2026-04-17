// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript verifier and query API for the tamper-evident audit chain.
 *
 * Reads JSONL audit files written by the Python orchestrator
 * (`nemoclaw-blueprint/orchestrator/audit.py`) and provides:
 *  - `verifyChain` — validate hash integrity and prev_hash linkage
 *  - `exportEntries` — query entries by timestamp
 *  - `tailEntries` — return the last N entries
 *
 * Hash verification uses canonical JSON serialization (sorted keys, no
 * whitespace) to match Python's `json.dumps(separators=(",",":"), sort_keys=True)`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// ── Public types ─────────────────────────────────────────────

/** A single audit log entry as written by the Python audit module. */
export interface AuditEntry {
  /** Unix epoch timestamp (seconds with fractional milliseconds). */
  readonly timestamp: number;
  /** SHA-256 hash of the previous entry, or "genesis" for the first entry. */
  readonly prev_hash: string;
  /** Arbitrary event payload recorded by the orchestrator. */
  readonly event: unknown;
  /** SHA-256 hash of this entry's canonical JSON representation (excluding hash itself). */
  readonly hash: string;
}

/** Result returned by `verifyChain`. */
export interface VerifyResult {
  /** True if the entire chain is valid. */
  readonly valid: boolean;
  /** Number of valid entries verified before a break (or total if valid). */
  readonly entries: number;
  /** Human-readable description of the first chain break, if any. */
  readonly error?: string;
}

// ── Standalone functions ─────────────────────────────────────

/**
 * Verify the integrity of an audit chain file.
 *
 * Reads every JSONL line, recomputes each entry hash using canonical JSON
 * serialization, and confirms that `prev_hash` links form an unbroken
 * chain starting from "genesis".
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

  let prevHash = "genesis";
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          valid: false,
          entries: count,
          error: `expected object at line ${String(i + 1)}`,
        };
      }
      entry = parsed as AuditEntry;
    } catch {
      return {
        valid: false,
        entries: count,
        error: `malformed JSON at line ${String(i + 1)}`,
      };
    }

    if (typeof entry.hash !== "string") {
      return {
        valid: false,
        entries: count,
        error: `missing hash field at line ${String(i + 1)}`,
      };
    }

    // Verify prev_hash links to the previous entry's hash
    if (entry.prev_hash !== prevHash) {
      return {
        valid: false,
        entries: count,
        error: `prev_hash mismatch at line ${String(i + 1)}`,
      };
    }

    // Reconstruct the payload without the hash field and recompute
    const payload: Record<string, unknown> = {
      timestamp: entry.timestamp,
      prev_hash: entry.prev_hash,
      event: entry.event,
    };

    const expectedHash = computeHash(payload);
    if (entry.hash !== expectedHash) {
      return {
        valid: false,
        entries: count,
        error: `hash mismatch at line ${String(i + 1)} (tampering detected)`,
      };
    }

    prevHash = entry.hash;
    count++;
  }

  return { valid: true, entries: count };
}

/**
 * Export audit entries with `timestamp >= since`, up to `limit`.
 *
 * If `limit` is 0 or omitted, all matching entries are returned.
 * Skips malformed lines.
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

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const result: AuditEntry[] = [];
  const effectiveLimit = limit != null && limit > 0 ? limit : 0;

  for (const line of lines) {
    let entry: AuditEntry;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isAuditEntry(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }

    if (entry.timestamp < since) {
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
 * Skips malformed lines.
 */
export function tailEntries(path: string, n?: number): AuditEntry[] {
  if (!path || typeof path !== "string") {
    throw new Error("tailEntries requires a non-empty file path");
  }

  const effectiveN = n != null && n > 0 ? n : 50;

  if (!existsSync(path)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const entries: AuditEntry[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAuditEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  if (entries.length <= effectiveN) {
    return entries;
  }

  return entries.slice(entries.length - effectiveN);
}

// ── Internal helpers ─────────────────────────────────────────

/** Runtime type guard: returns true if value looks like a valid AuditEntry. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["timestamp"] === "number" &&
    typeof obj["prev_hash"] === "string" &&
    typeof obj["hash"] === "string" &&
    "event" in obj
  );
}

/**
 * Compute the SHA-256 hash of a record using canonical JSON serialization.
 *
 * Matches Python's `json.dumps(record, separators=(",",":"), sort_keys=True)`
 * by recursively sorting object keys and using compact separators.
 */
function computeHash(obj: Record<string, unknown>): string {
  const canonical = canonicalJsonStringify(obj);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Produce a canonical JSON string with sorted keys and no whitespace.
 * Matches Python's `json.dumps(obj, separators=(",",":"), sort_keys=True)`.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return escapeNonAscii(JSON.stringify(value));
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`,
    );
    return `{${pairs.join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Escape non-ASCII characters to \\uXXXX sequences to match Python's
 * `json.dumps(ensure_ascii=True)` default behavior. Characters above
 * U+FFFF are encoded as surrogate pairs (\\uXXXX\\uXXXX).
 */
function escapeNonAscii(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) {
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      result += s[i];
    }
  }
  return result;
}
