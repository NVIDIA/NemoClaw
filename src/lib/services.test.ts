// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import from compiled dist/ so coverage is attributed correctly.
import {
  getServiceStatuses,
  showStatus,
  stopAll,
} from "../../dist/lib/services";

describe("getServiceStatuses", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns stopped status when no PID files exist", () => {
    const statuses = getServiceStatuses({ pidDir });
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.running).toBe(false);
      expect(s.pid).toBeNull();
    }
  });

  it("returns service names telegram-bridge and cloudflared", () => {
    const statuses = getServiceStatuses({ pidDir });
    const names = statuses.map((s) => s.name);
    expect(names).toContain("telegram-bridge");
    expect(names).toContain("cloudflared");
  });

  it("detects a stale PID file as not running with null pid", () => {
    // Write a PID that doesn't correspond to a running process
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf?.running).toBe(false);
    // Dead processes should have pid normalized to null
    expect(cf?.pid).toBeNull();
  });

  it("ignores invalid PID file contents", () => {
    writeFileSync(join(pidDir, "telegram-bridge.pid"), "not-a-number");
    const statuses = getServiceStatuses({ pidDir });
    const tg = statuses.find((s) => s.name === "telegram-bridge");
    expect(tg?.pid).toBeNull();
    expect(tg?.running).toBe(false);
  });

  it("creates pidDir if it does not exist", () => {
    const nested = join(pidDir, "nested", "deep");
    const statuses = getServiceStatuses({ pidDir: nested });
    expect(existsSync(nested)).toBe(true);
    expect(statuses).toHaveLength(2);
  });
});

describe("sandbox name validation", () => {
  it("rejects names with path traversal", () => {
    expect(() => getServiceStatuses({ sandboxName: "../escape" })).toThrow("Invalid sandbox name");
  });

  it("rejects names with slashes", () => {
    expect(() => getServiceStatuses({ sandboxName: "foo/bar" })).toThrow("Invalid sandbox name");
  });

  it("rejects empty names", () => {
    expect(() => getServiceStatuses({ sandboxName: "" })).toThrow("Invalid sandbox name");
  });

  it("accepts valid alphanumeric names", () => {
    expect(() => getServiceStatuses({ sandboxName: "my-sandbox.1" })).not.toThrow();
  });
});

describe("showStatus", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("prints stopped status for all services", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("telegram-bridge");
    expect(output).toContain("cloudflared");
    expect(output).toContain("stopped");
    logSpy.mockRestore();
  });

  it("does not show tunnel URL when cloudflared is not running", () => {
    // Write a stale log file but no running process
    writeFileSync(
      join(pidDir, "cloudflared.log"),
      "https://abc-def.trycloudflare.com",
    );
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    // Should NOT show the URL since cloudflared is not actually running
    expect(output).not.toContain("Public URL");
    logSpy.mockRestore();
  });
});

describe("stopAll", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("removes stale PID files", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    writeFileSync(join(pidDir, "telegram-bridge.pid"), "999999998");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    logSpy.mockRestore();

    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    expect(existsSync(join(pidDir, "telegram-bridge.pid"))).toBe(false);
  });

  it("is idempotent — calling twice does not throw", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    stopAll({ pidDir });
    logSpy.mockRestore();
  });

  it("logs stop messages", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });
});
