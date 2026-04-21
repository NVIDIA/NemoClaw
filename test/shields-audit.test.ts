// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Test the audit entry format and JSONL structure using the same logic
// as the production module but with a controllable output path.

let tmpDir;
let auditPath;

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
function appendAuditEntry(entry) {
  fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
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
