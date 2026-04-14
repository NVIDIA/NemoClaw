// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendAuditEntry,
  AuditParseError,
  computeEntryHash,
  GENESIS_HASH,
  readAllEntries,
  readLastEntry,
  verifyAuditLog,
  type AuditEntry,
} from "./audit-log";

describe("audit-log", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nemoclaw-audit-test-"));
    logPath = join(tempDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -- appendAuditEntry ---------------------------------------------------

  describe("appendAuditEntry", () => {
    it("creates the first entry with GENESIS_HASH as prev_hash", () => {
      const entry = appendAuditEntry("sandbox.create", "Created sandbox foo", {
        logPath,
        actor: "host",
      });

      expect(entry.seq).toBe(0);
      expect(entry.prev_hash).toBe(GENESIS_HASH);
      expect(entry.event).toBe("sandbox.create");
      expect(entry.message).toBe("Created sandbox foo");
      expect(entry.actor).toBe("host");
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("chains entries correctly", () => {
      const first = appendAuditEntry("sandbox.create", "Created", { logPath });
      const second = appendAuditEntry("sandbox.connect", "Connected", { logPath });

      expect(second.seq).toBe(1);
      expect(second.prev_hash).toBe(first.hash);
    });

    it("writes entries as JSONL lines", () => {
      appendAuditEntry("event.a", "First", { logPath });
      appendAuditEntry("event.b", "Second", { logPath });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(2);

      // Each line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("stores optional metadata", () => {
      const entry = appendAuditEntry("sandbox.destroy", "Destroyed bar", {
        logPath,
        meta: { sandbox: "bar", reason: "user-requested" },
      });

      expect(entry.meta).toEqual({ sandbox: "bar", reason: "user-requested" });
    });

    it("defaults actor to host", () => {
      const entry = appendAuditEntry("test", "test msg", { logPath });
      expect(entry.actor).toBe("host");
    });
  });

  // -- computeEntryHash ---------------------------------------------------

  describe("computeEntryHash", () => {
    it("is deterministic for the same input", () => {
      const partial = {
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
        prev_hash: GENESIS_HASH,
        event: "test",
        message: "hello",
        actor: "host",
      };

      const h1 = computeEntryHash(partial);
      const h2 = computeEntryHash(partial);
      expect(h1).toBe(h2);
    });

    it("changes when any field changes", () => {
      const base = {
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
        prev_hash: GENESIS_HASH,
        event: "test",
        message: "hello",
        actor: "host",
      };

      const altered = { ...base, message: "goodbye" };
      expect(computeEntryHash(base)).not.toBe(computeEntryHash(altered));
    });
  });

  // -- readAllEntries / readLastEntry --------------------------------------

  describe("readAllEntries", () => {
    it("returns empty array for non-existent file", () => {
      expect(readAllEntries(join(tempDir, "nope.jsonl"))).toEqual([]);
    });

    it("returns all written entries in order", () => {
      appendAuditEntry("a", "first", { logPath });
      appendAuditEntry("b", "second", { logPath });
      appendAuditEntry("c", "third", { logPath });

      const entries = readAllEntries(logPath);
      expect(entries).toHaveLength(3);
      expect(entries[0].event).toBe("a");
      expect(entries[1].event).toBe("b");
      expect(entries[2].event).toBe("c");
    });
  });

  describe("readLastEntry", () => {
    it("returns null for non-existent file", () => {
      expect(readLastEntry(join(tempDir, "nope.jsonl"))).toBeNull();
    });

    it("returns the last entry", () => {
      appendAuditEntry("a", "first", { logPath });
      appendAuditEntry("b", "second", { logPath });

      const last = readLastEntry(logPath);
      expect(last?.event).toBe("b");
      expect(last?.seq).toBe(1);
    });
  });

  // -- verifyAuditLog -----------------------------------------------------

  describe("verifyAuditLog", () => {
    it("validates an empty log as OK", () => {
      const result = verifyAuditLog(join(tempDir, "nope.jsonl"));
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(0);
    });

    it("validates a correctly-chained log", () => {
      appendAuditEntry("sandbox.create", "Created", { logPath });
      appendAuditEntry("sandbox.connect", "Connected", { logPath });
      appendAuditEntry("sandbox.destroy", "Destroyed", { logPath });

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect(result.brokenAt).toBe(-1);
      expect(result.errors).toEqual([]);
    });

    it("detects a tampered entry (modified message)", () => {
      appendAuditEntry("sandbox.create", "Created", { logPath });
      appendAuditEntry("sandbox.connect", "Connected", { logPath });

      // Tamper with the first entry message
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trimEnd().split("\n");
      const entry0 = JSON.parse(lines[0]) as AuditEntry;
      entry0.message = "TAMPERED";
      lines[0] = JSON.stringify(entry0);
      writeFileSync(logPath, lines.join("\n") + "\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("detects a deleted entry (broken sequence)", () => {
      appendAuditEntry("a", "first", { logPath });
      appendAuditEntry("b", "second", { logPath });
      appendAuditEntry("c", "third", { logPath });

      // Remove the middle entry
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trimEnd().split("\n");
      const remaining = [lines[0], lines[2]];
      writeFileSync(logPath, remaining.join("\n") + "\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      // Entry at index 1 will have wrong seq and wrong prev_hash
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("detects an injected entry with wrong prev_hash", () => {
      appendAuditEntry("a", "first", { logPath });

      // Inject a fake second entry with wrong prev_hash
      const fake = {
        timestamp: new Date().toISOString(),
        seq: 1,
        prev_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        event: "fake",
        message: "injected",
        actor: "attacker",
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
      const content = readFileSync(logPath, "utf-8");
      writeFileSync(logPath, content + JSON.stringify(fake) + "\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it("detects wrong genesis hash", () => {
      appendAuditEntry("a", "first", { logPath });

      // Tamper the first entry prev_hash
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trimEnd().split("\n");
      const entry0 = JSON.parse(lines[0]) as AuditEntry;
      entry0.prev_hash = "ff".repeat(32);
      lines[0] = JSON.stringify(entry0);
      writeFileSync(logPath, lines.join("\n") + "\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("prev_hash mismatch"))).toBe(true);
    });

    it("detects malformed JSONL without throwing", () => {
      appendAuditEntry("a", "first", { logPath });
      // Inject a corrupt line
      const content = readFileSync(logPath, "utf-8");
      writeFileSync(logPath, content + "NOT VALID JSON\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.errors[0]).toContain("Malformed JSONL");
    });

    it("detects tampered nested metadata", () => {
      appendAuditEntry("a", "first", {
        logPath,
        meta: { nested: { key: "original" } },
      });

      // Tamper with nested meta
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trimEnd().split("\n");
      const entry0 = JSON.parse(lines[0]) as AuditEntry;
      (entry0.meta as Record<string, unknown>).nested = { key: "tampered" };
      lines[0] = JSON.stringify(entry0);
      writeFileSync(logPath, lines.join("\n") + "\n");

      const result = verifyAuditLog(logPath);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(0);
      expect(result.errors.some((e) => e.includes("hash mismatch"))).toBe(true);
    });
  });

  // -- readAllEntries error handling -----------------------------------------

  describe("readAllEntries", () => {
    it("throws AuditParseError on malformed JSONL", () => {
      writeFileSync(logPath, '{"valid": true}\nNOT JSON\n');
      expect(() => readAllEntries(logPath)).toThrow(AuditParseError);
      try {
        readAllEntries(logPath);
      } catch (err) {
        expect(err).toBeInstanceOf(AuditParseError);
        expect((err as AuditParseError).lineIndex).toBe(1);
      }
    });
  });
});
