// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRecentShieldsAutoRestore,
  type ShieldsAutoRestoreEvent,
  type ShieldsAutoRestoreReadResult,
} from "./audit";

// Test the audit entry format and JSONL structure using the same logic
// as the production module but with a controllable output path.

type AuditScalar = string | number | boolean | null | undefined;
type AuditValue = AuditScalar | AuditRecord | AuditValue[];
type AuditRecord = { [key: string]: AuditValue };

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-audit-test-"));
  auditPath = path.join(tmpDir, "shields-audit.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Inline audit append — mirrors the production appendAuditEntry() but writes
 * to our test-controlled path instead of ~/.nemoclaw/state/.
 */
function appendAuditEntry(entry: AuditRecord) {
  fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

function requireEvent(result: ShieldsAutoRestoreReadResult): ShieldsAutoRestoreEvent {
  expect(result.kind).toBe("event");
  return (result as Extract<ShieldsAutoRestoreReadResult, { kind: "event" }>).event;
}

describe("shields-audit", () => {
  it("creates file on first write and writes valid JSONL", () => {
    expect(fs.existsSync(auditPath)).toBe(false);

    appendAuditEntry({
      action: "shields_down",
      sandbox: "openclaw",
      timestamp: "2026-04-13T14:30:00Z",
      timeout_seconds: 300,
      reason: "Installing Slack plugin",
      policy_applied: "permissive",
      policy_snapshot: "/tmp/snapshot.yaml",
    });

    expect(fs.existsSync(auditPath)).toBe(true);
    const content = fs.readFileSync(auditPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe("shields_down");
    expect(entry.sandbox).toBe("openclaw");
    expect(entry.timeout_seconds).toBe(300);
  });

  it("appends multiple entries as separate lines", () => {
    appendAuditEntry({
      action: "shields_down",
      sandbox: "openclaw",
      timestamp: "2026-04-13T14:30:00Z",
    });

    appendAuditEntry({
      action: "shields_up",
      sandbox: "openclaw",
      timestamp: "2026-04-13T14:32:00Z",
      restored_by: "operator",
      duration_seconds: 120,
    });

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const second = JSON.parse(lines[1]);
    expect(second.action).toBe("shields_up");
    expect(second.restored_by).toBe("operator");
    expect(second.duration_seconds).toBe(120);
  });

  it("each line is valid JSON", () => {
    for (let i = 0; i < 5; i++) {
      appendAuditEntry({
        action: "shields_down",
        sandbox: `sandbox-${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("never includes credential-like values in entries", () => {
    const entry = {
      action: "shields_down",
      sandbox: "openclaw",
      timestamp: "2026-04-13T14:30:00Z",
      reason: "Installing plugin",
      policy_applied: "permissive",
    };

    appendAuditEntry(entry);

    const line = fs.readFileSync(auditPath, "utf-8").trim();
    expect(line).not.toContain("nvapi-");
    expect(line).not.toContain("ghp_");
    expect(line).not.toContain("sk-");
  });
});

describe("readRecentShieldsAutoRestore", () => {
  it("returns timestamp and timeoutSeconds when shields_down precedes shields_auto_restore (#5922)", () => {
    const now = new Date().toISOString();
    fs.appendFileSync(
      auditPath,
      JSON.stringify({
        action: "shields_down",
        sandbox: "alpha",
        timestamp: new Date(Date.now() - 25 * 1000).toISOString(),
        timeout_seconds: 20,
      }) +
        "\n" +
        JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: now }) +
        "\n",
    );
    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(now);
    expect(event.timeoutSeconds).toBe(20);
  });

  it("returns timestamp with null timeoutSeconds when no shields_down entry exists (#5922)", () => {
    const now = new Date().toISOString();
    fs.appendFileSync(
      auditPath,
      JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: now }) + "\n",
    );
    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(now);
    expect(event.timeoutSeconds).toBeNull();
  });

  it("returns no event when the shields_auto_restore entry is future-dated (#5922)", () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    fs.appendFileSync(
      auditPath,
      JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: future }) +
        "\n",
    );
    const result = readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns no event when the most recent shields_auto_restore entry is older than the window (#5922)", () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.appendFileSync(
      auditPath,
      JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: old }) + "\n",
    );
    const result = readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns no event when the recent shields_auto_restore entry is for a different sandbox (#5922)", () => {
    const now = new Date().toISOString();
    fs.appendFileSync(
      auditPath,
      JSON.stringify({ action: "shields_auto_restore", sandbox: "other-sb", timestamp: now }) +
        "\n",
    );
    const result = readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns no event when the audit file does not exist (#5922)", () => {
    const result = readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns null timeoutSeconds for out-of-bounds timeout values in shields_down entry (#5922)", () => {
    const now = new Date().toISOString();
    // JSON.stringify serializes these correctly (finite numbers)
    for (const bad of [0, -1, 1801, 9999, 1.5]) {
      fs.writeFileSync(
        auditPath,
        JSON.stringify({
          action: "shields_down",
          sandbox: "alpha",
          timestamp: new Date(Date.now() - 25 * 1000).toISOString(),
          timeout_seconds: bad,
        }) +
          "\n" +
          JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: now }) +
          "\n",
      );
      const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
      expect(event.timestamp, `bad value ${String(bad)}`).toBe(now);
      expect(event.timeoutSeconds, `bad value ${String(bad)}`).toBeNull();
    }
  });

  it("returns correct timeoutSeconds when a malformed JSONL line sits between shields_down and shields_auto_restore (#5922)", () => {
    const now = new Date().toISOString();
    const downLine = JSON.stringify({
      action: "shields_down",
      sandbox: "alpha",
      timestamp: new Date(Date.now() - 25 * 1000).toISOString(),
      timeout_seconds: 30,
    });
    // Malformed line between the two valid entries; parseEntry must skip it and
    // continue to find the preceding shields_down.
    fs.writeFileSync(
      auditPath,
      downLine +
        "\n{not valid json\n" +
        JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: now }) +
        "\n",
    );
    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(now);
    expect(event.timeoutSeconds).toBe(30);
  });

  it("uses the immediately-preceding shields_down when multiple exist (#5922)", () => {
    const now = new Date().toISOString();
    // Two shields_down entries with different timeout_seconds. The second (most
    // recent) should be used because it immediately precedes the auto-restore.
    fs.writeFileSync(
      auditPath,
      JSON.stringify({
        action: "shields_down",
        sandbox: "alpha",
        timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
        timeout_seconds: 120,
      }) +
        "\n" +
        JSON.stringify({
          action: "shields_down",
          sandbox: "alpha",
          timestamp: new Date(Date.now() - 25 * 1000).toISOString(),
          timeout_seconds: 45,
        }) +
        "\n" +
        JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp: now }) +
        "\n",
    );
    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(now);
    expect(event.timeoutSeconds).toBe(45);
  });

  it("returns null timeoutSeconds when shields_down has NaN or Infinity as a raw string payload (#5922)", () => {
    // JSON.stringify(NaN) and JSON.stringify(Infinity) both produce "null",
    // so write the JSONL line manually to exercise the non-finite path.
    const now = new Date().toISOString();
    for (const rawValue of ["NaN", "Infinity", "-Infinity"]) {
      const downLine = `{"action":"shields_down","sandbox":"alpha","timestamp":"${new Date(Date.now() - 25 * 1000).toISOString()}","timeout_seconds":${rawValue}}`;
      const restoreLine = JSON.stringify({
        action: "shields_auto_restore",
        sandbox: "alpha",
        timestamp: now,
      });
      fs.writeFileSync(auditPath, downLine + "\n" + restoreLine + "\n");
      // Malformed JSON (NaN/Infinity are not valid JSON) → parseEntry returns null → timeoutSeconds stays null
      const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
      expect(event.timestamp, `raw value ${rawValue}`).toBe(now);
      expect(event.timeoutSeconds, `raw value ${rawValue}`).toBeNull();
    }
  });

  it("distinguishes unreadable audit history from an absent audit file (#5922)", () => {
    fs.mkdirSync(auditPath);
    expect(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath)).toEqual({
      kind: "unreadable",
    });
  });

  it("skips invalid restore timestamps and finds the next valid recent event (#5922)", () => {
    const validTimestamp = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(
      auditPath,
      [
        JSON.stringify({
          action: "shields_auto_restore",
          sandbox: "alpha",
          timestamp: validTimestamp,
        }),
        JSON.stringify({
          action: "shields_auto_restore",
          sandbox: "alpha",
          timestamp: "not-a-timestamp",
        }),
      ].join("\n") + "\n",
    );

    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(validTimestamp);
  });

  it("skips non-object JSONL tail rows while finding a valid restore event (#5922)", () => {
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      auditPath,
      [
        JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp }),
        "null",
        "[]",
        '"text"',
        "42",
      ].join("\n") + "\n",
    );

    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(timestamp);
  });

  it("reads only the bounded audit tail and discards its partial first line (#5922)", () => {
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      auditPath,
      "x".repeat(1024 * 1024 + 100) +
        "\n" +
        JSON.stringify({ action: "shields_auto_restore", sandbox: "alpha", timestamp }) +
        "\n",
    );

    const event = requireEvent(readRecentShieldsAutoRestore("alpha", 10 * 60 * 1000, auditPath));
    expect(event.timestamp).toBe(timestamp);
  });
});
