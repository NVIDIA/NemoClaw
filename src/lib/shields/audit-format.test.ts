// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("shields-audit format", () => {
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

// Pin the PRODUCTION appendAuditEntry (not an inline reimplementation): the
// real writer must strip credential values from every serialized record kind.
// This closes the gap where only the live shields-config E2E asserted that the
// on-disk shields-audit.jsonl never persists secrets. The real module captures
// its AUDIT_FILE path from resolveNemoclawStateDir(process.env.HOME) at load
// time, so each case points HOME at a temp dir and re-imports for a fresh path.
describe("shields-audit production redaction", () => {
  let homeDir: string;
  let realAuditPath: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-audit-home-"));
    realAuditPath = path.join(homeDir, ".nemoclaw", "state", "shields-audit.jsonl");
    savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    Object.assign(process.env, savedHome === undefined ? {} : { HOME: savedHome });
    vi.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  async function loadAppendAuditEntry() {
    const mod = await import("./audit");
    return mod.appendAuditEntry;
  }

  const SECRETS = {
    nvapi: "nvapi-abcdefghijklmnopqrstuvwxyz0123456789",
    sk: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    bearer: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  } as const;

  function assertNoSecrets(line: string) {
    expect(line).not.toContain(SECRETS.nvapi);
    expect(line).not.toContain(SECRETS.sk);
    expect(line).not.toContain(SECRETS.bearer);
    expect(line).not.toContain("nvapi-a");
    expect(line).not.toContain("sk-abcdef");
  }

  it.each([
    "shields_down",
    "shields_up",
    "shields_auto_restore",
  ] as const)("strips nvapi-/sk-/Bearer secrets from the free-text reason of %s records", async (action) => {
    const appendAuditEntry = await loadAppendAuditEntry();
    appendAuditEntry({
      action,
      sandbox: "openclaw",
      timestamp: "2026-04-13T14:30:00Z",
      reason: `key=${SECRETS.nvapi} also ${SECRETS.sk} and ${SECRETS.bearer}`,
    });

    const line = fs.readFileSync(realAuditPath, "utf-8").trim();
    assertNoSecrets(line);
    // The line must still be a valid, parseable JSONL entry after redaction.
    const entry = JSON.parse(line);
    expect(entry.action).toBe(action);
    expect(entry.sandbox).toBe("openclaw");
  });

  it("strips secrets from the error field while preserving benign fields", async () => {
    const appendAuditEntry = await loadAppendAuditEntry();
    appendAuditEntry({
      action: "shields_up_failed",
      sandbox: "hermes",
      timestamp: "2026-04-13T14:30:00Z",
      error: `guard failed using ${SECRETS.nvapi} / ${SECRETS.bearer}`,
      reason: `retry with ${SECRETS.sk}`,
      policy_applied: "permissive",
    });

    const line = fs.readFileSync(realAuditPath, "utf-8").trim();
    assertNoSecrets(line);
    const entry = JSON.parse(line);
    // Structured, non-secret fields survive redaction verbatim.
    expect(entry.sandbox).toBe("hermes");
    expect(entry.policy_applied).toBe("permissive");
    expect(entry.action).toBe("shields_up_failed");
  });
});
