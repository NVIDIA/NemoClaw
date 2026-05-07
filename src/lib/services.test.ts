// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import childProcess, { type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Import from compiled dist/ so coverage is attributed correctly.
import { getServiceStatuses, showStatus, stopAll } from "../../dist/lib/services";

const ollamaProxyDistPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "lib",
  "onboard-ollama-proxy.js",
);

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
    expect(statuses).toHaveLength(1);
    for (const s of statuses) {
      expect(s.running).toBe(false);
      expect(s.pid).toBeNull();
    }
  });

  it("returns service name cloudflared", () => {
    const statuses = getServiceStatuses({ pidDir });
    const names = statuses.map((s) => s.name);
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
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    const statuses = getServiceStatuses({ pidDir });
    const cf = statuses.find((s) => s.name === "cloudflared");
    expect(cf?.pid).toBeNull();
    expect(cf?.running).toBe(false);
  });

  it("creates pidDir if it does not exist", () => {
    const nested = join(pidDir, "nested", "deep");
    const statuses = getServiceStatuses({ pidDir: nested });
    expect(existsSync(nested)).toBe(true);
    expect(statuses).toHaveLength(1);
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
    expect(output).toContain("cloudflared");
    expect(output).toContain("stopped");
    logSpy.mockRestore();
  });

  it("does not show tunnel URL when cloudflared is not running", () => {
    // Write a stale log file but no running process
    writeFileSync(join(pidDir, "cloudflared.log"), "https://abc-def.trycloudflare.com");
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
  let spawnSyncCalls: Array<{ command: string; args: readonly string[] }>;
  let originalSpawnSync: typeof childProcess.spawnSync;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-test-"));
    spawnSyncCalls = [];
    originalSpawnSync = childProcess.spawnSync;
    // @ts-expect-error — partial mock signature is intentional.
    childProcess.spawnSync = (command: string, args: readonly string[]) => {
      spawnSyncCalls.push({ command, args });
      const reply: SpawnSyncReturns<string> = {
        pid: 0,
        output: ["", "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      };
      // Return an empty model list so the unload's for-loop is a no-op.
      if (command === "curl" && args.some((a) => a.endsWith("/api/ps"))) {
        reply.stdout = JSON.stringify({ models: [] });
        reply.output = ["", reply.stdout, ""];
      }
      return reply;
    };
    // The dist `onboard-ollama-proxy` module destructures `spawnSync` at
    // require time, so to make `stopAll` pick up the patched function we
    // bust its cache. `services.ts` requires the proxy lazily, so the
    // next call sees the freshly-loaded module.
    delete require.cache[require.resolve(ollamaProxyDistPath)];
  });

  afterEach(() => {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[require.resolve(ollamaProxyDistPath)];
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("removes stale PID files", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    logSpy.mockRestore();

    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
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

  it("unloads Ollama models before reporting services stopped", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir });
    logSpy.mockRestore();

    const psCall = spawnSyncCalls.find(
      (c) =>
        c.command === "curl" &&
        c.args.some((a) => a.endsWith("/api/ps")),
    );
    expect(psCall).toBeDefined();
    expect(psCall?.args).toContain("--max-time");
  });
});
