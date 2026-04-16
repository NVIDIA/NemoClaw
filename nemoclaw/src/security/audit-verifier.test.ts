// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain, exportEntries, tailEntries, type AuditEntry } from "./audit-verifier.js";

// ── Test helpers ─────────────────────────────────────────────

/** Produce canonical JSON matching Python's json.dumps(separators=(",",":"), sort_keys=True). */
function canonicalJson(obj: Record<string, unknown>): string {
  return stableStringify(obj);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/** Build an audit entry matching the Python format. */
function makeEntry(event: unknown, prevHash: string, timestamp: number): AuditEntry {
  const record: Record<string, unknown> = { timestamp, prev_hash: prevHash, event };
  const hash = sha256(canonicalJson(record));
  return { timestamp, prev_hash: prevHash, event, hash };
}

/** Build a chain of N entries. */
function makeChain(n: number, startTimestamp = 1700000000): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = "genesis";
  for (let i = 0; i < n; i++) {
    const entry = makeEntry({ action: `event_${String(i)}`, seq: i }, prevHash, startTimestamp + i);
    entries.push(entry);
    prevHash = entry.hash;
  }
  return entries;
}

function writeChain(path: string, entries: AuditEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, content, "utf-8");
}

// ── Test suite ───────────────────────────────────────────────

let tempDir: string;
let auditPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "audit-verifier-"));
  auditPath = join(tempDir, "audit.jsonl");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("verifyChain", () => {
  it("returns valid for nonexistent file", () => {
    const result = verifyChain(join(tempDir, "nonexistent.jsonl"));
    expect(result).toEqual({ valid: true, entries: 0 });
  });

  it("returns valid for empty file", () => {
    writeFileSync(auditPath, "", "utf-8");
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 0 });
  });

  it("returns valid for whitespace-only file", () => {
    writeFileSync(auditPath, "\n\n  \n", "utf-8");
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 0 });
  });

  it("validates a single-entry chain", () => {
    const entries = makeChain(1);
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 1 });
  });

  it("validates a multi-entry chain", () => {
    const entries = makeChain(10);
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 10 });
  });

  it("validates a 100-entry chain", () => {
    const entries = makeChain(100);
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 100 });
  });

  it("detects modified event data", () => {
    const entries = makeChain(5);
    // Tamper with entry 3's event
    const tampered = { ...entries[2], event: { action: "tampered", seq: 999 } };
    entries[2] = tampered;
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("hash mismatch at line 3");
  });

  it("detects modified hash field", () => {
    const entries = makeChain(3);
    entries[1] = { ...entries[1], hash: "aaaa" + entries[1].hash.slice(4) };
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.entries).toBe(1);
  });

  it("detects broken prev_hash link", () => {
    const entries = makeChain(5);
    entries[3] = { ...entries[3], prev_hash: "wrong_hash" };
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("prev_hash mismatch at line 4");
  });

  it("detects deleted entry (gap in chain)", () => {
    const entries = makeChain(5);
    // Remove entry at index 2 — entry 3 will have prev_hash pointing to entry 2
    entries.splice(2, 1);
    writeChain(auditPath, entries);
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("prev_hash mismatch");
  });

  it("detects chain splice (entries from different chains)", () => {
    const chain1 = makeChain(3, 1700000000);
    const chain2 = makeChain(3, 1700001000);
    // Splice: first 2 from chain1, then entry 2 from chain2
    const spliced = [chain1[0], chain1[1], chain2[2]];
    writeChain(auditPath, spliced);
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("prev_hash mismatch");
  });

  it("handles malformed JSON line gracefully", () => {
    const entries = makeChain(3);
    const lines = entries.map((e) => JSON.stringify(e));
    lines.splice(1, 0, "{ this is not valid json");
    writeFileSync(auditPath, lines.join("\n") + "\n", "utf-8");
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("malformed JSON at line 2");
  });

  it("handles missing hash field", () => {
    const record = { timestamp: 1700000000, prev_hash: "genesis", event: { test: true } };
    writeFileSync(auditPath, JSON.stringify(record) + "\n", "utf-8");
    const result = verifyChain(auditPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("missing hash field");
  });

  it("returns error for empty path", () => {
    const result = verifyChain("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("path is required");
  });
});

describe("exportEntries", () => {
  it("returns empty array for nonexistent file", () => {
    const entries = exportEntries(join(tempDir, "missing.jsonl"), 0);
    expect(entries).toEqual([]);
  });

  it("returns all entries when since is 0", () => {
    const chain = makeChain(5);
    writeChain(auditPath, chain);
    const entries = exportEntries(auditPath, 0);
    expect(entries).toHaveLength(5);
  });

  it("filters by timestamp", () => {
    const chain = makeChain(5, 1700000000);
    writeChain(auditPath, chain);
    // Entries have timestamps 1700000000..1700000004
    const entries = exportEntries(auditPath, 1700000003);
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe(1700000003);
    expect(entries[1].timestamp).toBe(1700000004);
  });

  it("respects limit", () => {
    const chain = makeChain(10);
    writeChain(auditPath, chain);
    const entries = exportEntries(auditPath, 0, 3);
    expect(entries).toHaveLength(3);
  });

  it("returns all when limit is 0", () => {
    const chain = makeChain(5);
    writeChain(auditPath, chain);
    const entries = exportEntries(auditPath, 0, 0);
    expect(entries).toHaveLength(5);
  });

  it("skips malformed lines", () => {
    const chain = makeChain(3);
    const lines = chain.map((e) => JSON.stringify(e));
    lines.splice(1, 0, "not json");
    writeFileSync(auditPath, lines.join("\n") + "\n", "utf-8");
    const entries = exportEntries(auditPath, 0);
    expect(entries).toHaveLength(3);
  });

  it("throws on empty path", () => {
    expect(() => exportEntries("", 0)).toThrow("non-empty file path");
  });

  it("throws on non-finite since", () => {
    expect(() => exportEntries(auditPath, NaN)).toThrow("finite number");
  });
});

describe("tailEntries", () => {
  it("returns empty array for nonexistent file", () => {
    const entries = tailEntries(join(tempDir, "missing.jsonl"));
    expect(entries).toEqual([]);
  });

  it("returns last N entries", () => {
    const chain = makeChain(10, 1700000000);
    writeChain(auditPath, chain);
    const entries = tailEntries(auditPath, 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].timestamp).toBe(1700000007);
    expect(entries[2].timestamp).toBe(1700000009);
  });

  it("defaults to 50 when n is omitted", () => {
    const chain = makeChain(60, 1700000000);
    writeChain(auditPath, chain);
    const entries = tailEntries(auditPath);
    expect(entries).toHaveLength(50);
    expect(entries[0].timestamp).toBe(1700000010);
  });

  it("returns all entries when fewer than n", () => {
    const chain = makeChain(3);
    writeChain(auditPath, chain);
    const entries = tailEntries(auditPath, 100);
    expect(entries).toHaveLength(3);
  });

  it("skips malformed lines", () => {
    const chain = makeChain(5);
    const lines = chain.map((e) => JSON.stringify(e));
    lines.push("broken json line");
    writeFileSync(auditPath, lines.join("\n") + "\n", "utf-8");
    const entries = tailEntries(auditPath, 3);
    expect(entries).toHaveLength(3);
  });

  it("throws on empty path", () => {
    expect(() => tailEntries("")).toThrow("non-empty file path");
  });
});

describe("cross-format verification", () => {
  it("verifies entries constructed to match Python output format", () => {
    // Simulate what Python's audit.py produces:
    // json.dumps({"timestamp": 1700000000, "prev_hash": "genesis", "event": {"action": "gateway_start", "pid": 42}}, separators=(",",":"), sort_keys=True)
    // = {"event":{"action":"gateway_start","pid":42},"prev_hash":"genesis","timestamp":1700000000}
    const payload =
      '{"event":{"action":"gateway_start","pid":42},"prev_hash":"genesis","timestamp":1700000000}';
    const hash = sha256(payload);

    const entry: AuditEntry = {
      timestamp: 1700000000,
      prev_hash: "genesis",
      event: { action: "gateway_start", pid: 42 },
      hash,
    };

    writeFileSync(auditPath, JSON.stringify(entry) + "\n", "utf-8");
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 1 });
  });

  it("verifies a two-entry chain matching Python format", () => {
    const payload1 =
      '{"event":{"action":"gateway_start"},"prev_hash":"genesis","timestamp":1700000000}';
    const hash1 = sha256(payload1);
    const entry1: AuditEntry = {
      timestamp: 1700000000,
      prev_hash: "genesis",
      event: { action: "gateway_start" },
      hash: hash1,
    };

    const payload2 = `{"event":{"action":"tool_call","tool":"write"},"prev_hash":"${hash1}","timestamp":1700000001}`;
    const hash2 = sha256(payload2);
    const entry2: AuditEntry = {
      timestamp: 1700000001,
      prev_hash: hash1,
      event: { action: "tool_call", tool: "write" },
      hash: hash2,
    };

    writeChain(auditPath, [entry1, entry2]);
    const result = verifyChain(auditPath);
    expect(result).toEqual({ valid: true, entries: 2 });
  });
});
