// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditLogger,
  verifyChain,
  exportEntries,
  tailEntries,
  type AuditEntry,
} from "./audit-chain.js";

// ── Test helpers ─────────────────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-chain-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** Read all entries from an audit file. */
function readEntries(path: string): AuditEntry[] {
  const content = readFileSync(path, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditEntry);
}

// ── AuditLogger ──────────────────────────────────────────────

describe("AuditLogger", () => {
  it("starts a new chain at seq 1 with empty prev_hash", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("test.action", { key: "value" });

    const entries = readEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].prev_hash).toBe("");
  });

  it("links entry hashes across entries", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("first", { n: 1 });
    logger.log("second", { n: 2 });

    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[1].prev_hash).toBe(entries[0].entry_hash);
  });

  it("increments sequence numbers", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});
    logger.log("c", {});

    const entries = readEntries(path);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("uses a consistent chain_id across entries", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});

    const entries = readEntries(path);
    expect(entries[0].chain_id).toBe(entries[1].chain_id);
    // chain_id is 24 hex chars (12 random bytes)
    expect(entries[0].chain_id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("resumes chain from an existing file", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");

    const logger1 = new AuditLogger(path);
    logger1.log("first", { n: 1 });
    const entriesBefore = readEntries(path);

    const logger2 = new AuditLogger(path);
    logger2.log("second", { n: 2 });

    const entries = readEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[1].seq).toBe(2);
    expect(entries[1].prev_hash).toBe(entriesBefore[0].entry_hash);
    expect(entries[1].chain_id).toBe(entries[0].chain_id);
  });

  it("stores the data payload correctly", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    const payload = { action: "file_write", target: "/tmp/test.txt", size: 42 };
    logger.log("tool.call", payload);

    const entries = readEntries(path);
    expect(entries[0].data).toEqual(payload);
    expect(entries[0].type).toBe("tool.call");
  });

  it("produces entry_hash in sha256:<64 hex chars> format", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("test", { x: 1 });

    const entries = readEntries(path);
    expect(entries[0].entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("stores an ISO 8601 timestamp", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("test", {});

    const entries = readEntries(path);
    const parsed = new Date(entries[0].time);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("throws on empty path", () => {
    expect(() => new AuditLogger("")).toThrow("non-empty file path");
  });

  it("throws on empty type", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    expect(() => {
      logger.log("", {});
    }).toThrow("non-empty type string");
  });

  it("handles single-char data", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("t", "x");

    const entries = readEntries(path);
    expect(entries[0].data).toBe("x");
    expect(entries[0].type).toBe("t");
  });

  it("handles extremely large data payload", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    const bigData = { blob: "A".repeat(100_000) };
    logger.log("big", bigData);

    const entries = readEntries(path);
    expect(entries).toHaveLength(1);
    expect((entries[0].data as { blob: string }).blob.length).toBe(100_000);
  });
});

// ── verifyChain ──────────────────────────────────────────────

describe("verifyChain", () => {
  it("returns valid for a correct chain", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", { n: 1 });
    logger.log("b", { n: 2 });
    logger.log("c", { n: 3 });

    const result = verifyChain(path);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("detects tampered data", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", { n: 1 });
    logger.log("b", { n: 2 });

    // Tamper with the data field of the first entry.
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const entry = JSON.parse(lines[0]) as AuditEntry;
    const tampered = { ...entry, data: { n: 999 } };
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");

    const result = verifyChain(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/entry_hash mismatch/);
  });

  it("detects broken prev_hash link", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", { n: 1 });
    logger.log("b", { n: 2 });

    // Replace the second entry's prev_hash with a bogus value.
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const entry = JSON.parse(lines[1]) as AuditEntry;
    const broken = {
      ...entry,
      prev_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    lines[1] = JSON.stringify(broken);
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");

    const result = verifyChain(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/prev_hash mismatch/);
  });

  it("returns valid for an empty file", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, "", "utf-8");

    const result = verifyChain(path);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(0);
  });

  it("returns valid for a nonexistent file", () => {
    const dir = makeTempDir();
    const path = join(dir, "does-not-exist.jsonl");

    const result = verifyChain(path);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(0);
  });

  it("handles malformed JSONL line", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, "not valid json\n", "utf-8");

    const result = verifyChain(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/malformed JSON at line 1/);
  });

  it("returns valid for exactly 1 entry", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("single", { only: true });

    const result = verifyChain(path);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(1);
  });

  it("returns error for empty path", () => {
    const result = verifyChain("");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/path is required/);
  });

  it("detects block-deletion attack (entries removed and chain re-linked)", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    for (let i = 1; i <= 5; i++) {
      logger.log("entry", { i });
    }

    // Read all 5 entries.
    const entries = readEntries(path);
    expect(entries).toHaveLength(5);

    // Delete entries 2 and 3. Re-link entry 4's prev_hash to entry 1's hash.
    const entry4 = { ...entries[3], prev_hash: entries[0].entry_hash };
    // Recompute entry 4's entry_hash to match the new prev_hash.
    const payload4 = {
      seq: entry4.seq,
      chain_id: entry4.chain_id,
      prev_hash: entry4.prev_hash,
      type: entry4.type,
      time: entry4.time,
      data: entry4.data,
    };
    const recomputedHash = `sha256:${createHash("sha256").update(JSON.stringify(payload4), "utf-8").digest("hex")}`;
    entry4.entry_hash = recomputedHash;

    // Also re-link entry 5's prev_hash to the recomputed entry 4 hash.
    const entry5 = { ...entries[4], prev_hash: recomputedHash };
    const payload5 = {
      seq: entry5.seq,
      chain_id: entry5.chain_id,
      prev_hash: entry5.prev_hash,
      type: entry5.type,
      time: entry5.time,
      data: entry5.data,
    };
    entry5.entry_hash = `sha256:${createHash("sha256").update(JSON.stringify(payload5), "utf-8").digest("hex")}`;

    // Write the tampered chain: entries 1, 4 (re-linked), 5 (re-linked).
    const tampered = [entries[0], entry4, entry5].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, tampered, "utf-8");

    // verifyChain should detect the sequence gap (seq jumps from 1 to 4).
    const result = verifyChain(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sequence gap/);
  });

  it("detects direct entry_hash replacement (hash changed but not data)", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", { n: 1 });

    const entries = readEntries(path);
    const tampered = {
      ...entries[0],
      entry_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    writeFileSync(path, JSON.stringify(tampered) + "\n", "utf-8");

    const result = verifyChain(path);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/entry_hash mismatch/);
  });

  it("detects chain_id splice (entry from different chain inserted)", () => {
    const dir = makeTempDir();

    // Create two separate chains.
    const pathA = join(dir, "chain-a.jsonl");
    const pathB = join(dir, "chain-b.jsonl");
    const loggerA = new AuditLogger(pathA);
    const loggerB = new AuditLogger(pathB);
    loggerA.log("a1", { source: "A" });
    loggerA.log("a2", { source: "A" });
    loggerB.log("b1", { source: "B" });

    const entriesA = readEntries(pathA);
    const entriesB = readEntries(pathB);

    // Splice: replace entry 2 of chain A with entry 1 from chain B,
    // adjusting seq and prev_hash to look plausible but keeping chain_id from B.
    const spliced = {
      ...entriesB[0],
      seq: 2,
      prev_hash: entriesA[0].entry_hash,
    };
    const splicedPayload = {
      seq: spliced.seq,
      chain_id: spliced.chain_id,
      prev_hash: spliced.prev_hash,
      type: spliced.type,
      time: spliced.time,
      data: spliced.data,
    };
    spliced.entry_hash = `sha256:${createHash("sha256").update(JSON.stringify(splicedPayload), "utf-8").digest("hex")}`;

    const targetPath = join(dir, "spliced.jsonl");
    writeFileSync(
      targetPath,
      JSON.stringify(entriesA[0]) + "\n" + JSON.stringify(spliced) + "\n",
      "utf-8",
    );

    const result = verifyChain(targetPath);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/chain_id mismatch/);
  });
});

// ── exportEntries ────────────────────────────────────────────

describe("exportEntries", () => {
  it("filters by since (sequence number)", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});
    logger.log("c", {});

    const entries = exportEntries(path, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(2);
    expect(entries[1].seq).toBe(3);
  });

  it("respects limit", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});
    logger.log("c", {});

    const entries = exportEntries(path, 1, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[1].seq).toBe(2);
  });

  it("returns all matching entries when limit is 0", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});

    const entries = exportEntries(path, 1, 0);
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for nonexistent file", () => {
    const dir = makeTempDir();
    const entries = exportEntries(join(dir, "missing.jsonl"), 1);
    expect(entries).toEqual([]);
  });

  it("skips malformed lines", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});

    // Append a malformed line followed by a valid entry.
    const logger2 = new AuditLogger(path);
    logger2.log("b", {});
    const contentAfter = readFileSync(path, "utf-8");
    const lines = contentAfter.split("\n").filter((l) => l.trim() !== "");
    // Insert malformed line between entries.
    const newContent = lines[0] + "\n{bad json\n" + lines[1] + "\n";
    writeFileSync(path, newContent, "utf-8");

    const entries = exportEntries(path, 1);
    expect(entries).toHaveLength(2);
  });

  it("throws on empty path", () => {
    expect(() => exportEntries("", 1)).toThrow("non-empty file path");
  });

  it("throws on non-finite since", () => {
    expect(() => exportEntries("/tmp/test", NaN)).toThrow("finite number");
  });
});

// ── tailEntries ──────────────────────────────────────────────

describe("tailEntries", () => {
  it("returns last N entries", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    for (let i = 1; i <= 10; i++) {
      logger.log("entry", { i });
    }

    const entries = tailEntries(path, 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].seq).toBe(8);
    expect(entries[1].seq).toBe(9);
    expect(entries[2].seq).toBe(10);
  });

  it("returns all entries if fewer than N", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});

    const entries = tailEntries(path, 100);
    expect(entries).toHaveLength(2);
  });

  it("defaults to 50 when n is omitted", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    for (let i = 1; i <= 60; i++) {
      logger.log("entry", { i });
    }

    const entries = tailEntries(path);
    expect(entries).toHaveLength(50);
    expect(entries[0].seq).toBe(11);
    expect(entries[49].seq).toBe(60);
  });

  it("defaults to 50 when n is 0", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    for (let i = 1; i <= 60; i++) {
      logger.log("entry", { i });
    }

    const entries = tailEntries(path, 0);
    expect(entries).toHaveLength(50);
  });

  it("returns empty array for nonexistent file", () => {
    const dir = makeTempDir();
    const entries = tailEntries(join(dir, "missing.jsonl"), 10);
    expect(entries).toEqual([]);
  });

  it("skips malformed lines", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);
    logger.log("a", {});
    logger.log("b", {});

    const content = readFileSync(path, "utf-8");
    // Insert a malformed line in the middle.
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    writeFileSync(path, lines[0] + "\n{broken\n" + lines[1] + "\n", "utf-8");

    const entries = tailEntries(path, 10);
    expect(entries).toHaveLength(2);
  });

  it("throws on empty path", () => {
    expect(() => tailEntries("")).toThrow("non-empty file path");
  });
});

// ── Rapid sequential writes ──────────────────────────────────

describe("rapid sequential writes", () => {
  it("handles rapid sequential writes without data loss", () => {
    const dir = makeTempDir();
    const path = join(dir, "audit.jsonl");
    const logger = new AuditLogger(path);

    for (let i = 0; i < 100; i++) {
      logger.log("rapid", { i });
    }

    const entries = readEntries(path);
    expect(entries).toHaveLength(100);
    expect(entries[99].seq).toBe(100);

    // Verify the entire chain is valid.
    const result = verifyChain(path);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(100);
  });
});
