// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("operational audit", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-operational-audit-"));
    vi.stubEnv("HOME", homeDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(homeDir, { force: true, recursive: true });
  });

  it("appends only supported mutation events as private JSONL with redacted reasons", async () => {
    const { appendAuditEntry, OPERATIONAL_AUDIT_FILE } = await import("./operational");
    const secret = "nvapi-abcdefghijklmnopqrstuvwxyz0123456789";

    appendAuditEntry({
      action: "inference_set",
      sandbox: "alpha",
      timestamp: "2026-08-31T12:00:00.000Z",
      reason: `inference set openclaw:nvidia-prod:model with ${secret}`,
    });
    appendAuditEntry({
      action: "config_set",
      sandbox: "alpha",
      timestamp: "2026-08-31T12:00:00.000Z",
      reason: `config set openclaw:models.default token=${secret}`,
    });
    appendAuditEntry({
      action: "rotate_token",
      sandbox: "alpha",
      timestamp: "2026-08-31T12:00:00.000Z",
      reason: `rotate-token openclaw:NVIDIA_INFERENCE_API_KEY ${secret}`,
    });

    const rows = fs
      .readFileSync(OPERATIONAL_AUDIT_FILE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    expect(rows.map(({ action, sandbox }) => ({ action, sandbox }))).toEqual([
      { action: "inference_set", sandbox: "alpha" },
      { action: "config_set", sandbox: "alpha" },
      { action: "rotate_token", sandbox: "alpha" },
    ]);
    expect(rows.map((row) => row.reason)).toEqual([
      expect.stringContaining("inference set openclaw:nvidia-prod:model"),
      expect.stringContaining("config set openclaw:models.default"),
      expect.stringContaining("rotate-token"),
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["action", "reason", "sandbox", "timestamp"]);
    expect(fs.statSync(OPERATIONAL_AUDIT_FILE).mode & 0o777).toBe(0o600);
  });

  it("reads a stable regular audit file without following a symbolic link", async () => {
    const { readStableOperationalAudit } = await import("./operational");
    const auditFile = path.join(homeDir, "audit.jsonl");
    const linkedFile = path.join(homeDir, "audit-link.jsonl");
    fs.writeFileSync(auditFile, '{"action":"config_set"}\n', { mode: 0o600 });
    fs.symlinkSync(auditFile, linkedFile);

    expect(readStableOperationalAudit(auditFile)).toBe('{"action":"config_set"}\n');
    expect(() => readStableOperationalAudit(linkedFile)).toThrow();
    expect(readStableOperationalAudit(path.join(homeDir, "missing.jsonl"))).toBe("");
  });

  it("bounds a descriptor read to the size validated before the file grows", async () => {
    const auditFile = path.join(homeDir, "growing-audit.jsonl");
    fs.writeFileSync(auditFile, "x", { mode: 0o600 });

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let requestedReadLength: number | undefined;
    const readSync = vi.fn(
      (descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
        requestedReadLength = length;
        return actualFs.readSync(descriptor, buffer, offset, length, position);
      },
    );
    const afterFstat = [() => actualFs.appendFileSync(auditFile, Buffer.alloc(8 * 1024 * 1024))];
    let fstatCalls = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      fstatSync: (descriptor: number, options: { bigint: true }) => {
        const stat = actualFs.fstatSync(descriptor, options);
        afterFstat[fstatCalls++]?.();
        return stat;
      },
      readSync,
    }));
    const { readStableOperationalAudit } = await import("./operational");

    expect(() => readStableOperationalAudit(auditFile)).toThrow(
      "config audit changed during rebuild capture",
    );
    expect(readSync).toHaveBeenCalledTimes(1);
    expect(requestedReadLength).toBe(1);
  });
});
