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
});
