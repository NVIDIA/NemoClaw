// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import childProcess, { type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Import from compiled dist/ so coverage is attributed correctly.
import {
  getServiceStatuses,
  readCloudflaredState,
  showStatus,
  stopAll,
} from "../../../dist/lib/tunnel/services";

const ollamaProxyDistPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dist",
  "lib",
  "inference",
  "ollama",
  "proxy.js",
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

  // #2604: wangericnv and Carlos (issue comments 2026-05-11, 2026-05-14) both
  // asked for a "no cloudflared process; restart with ..." shape — a cause
  // phrase plus a single-command recovery. All three failure modes surface
  // "no cloudflared process" and point at `nemoclaw tunnel start`, which
  // overwrites a stale PID file when isRunning() is false (see startService).
  it("prints `tunnel start` remediation when the PID file is missing (stopped)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stopped)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });

  it("prints `tunnel start` remediation when the PID file holds garbage (stale-pid-file)", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stale PID file)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });

  it("prints `tunnel start` remediation when the PID points at a dead process (stale-pid-process)", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    showStatus({ pidDir });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("(stale PID 999999999)");
    expect(output).toContain("no cloudflared process");
    expect(output).toContain("PID 999999999 is dead or not cloudflared");
    expect(output).toContain("nemoclaw tunnel start");
    logSpy.mockRestore();
  });
});

// #2604: readCloudflaredState is the shared source of truth used by both
// showStatus and the doctor's cloudflared check. Tests below exercise each
// branch of the discriminated union.
describe("readCloudflaredState", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-state-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("returns stopped when no PID file exists", () => {
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stopped" });
  });

  it("returns stopped when the PID file is empty", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "");
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stopped" });
  });

  it("returns stale-pid-file when contents are not parseable as a positive integer", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "not-a-number");
    expect(readCloudflaredState(pidDir)).toEqual({ kind: "stale-pid-file" });
  });

  it("returns stale-pid-process when the PID is dead (kernel ESRCH)", () => {
    // PID > max(int32) is virtually guaranteed dead on macOS/Linux.
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    const state = readCloudflaredState(pidDir);
    expect(state.kind).toBe("stale-pid-process");
    if (state.kind === "stale-pid-process") expect(state.pid).toBe(999999999);
  });

  it("returns stale-pid-process when the PID points at a different process", () => {
    // Use this test process's own PID — guaranteed alive, but not cloudflared.
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    const state = readCloudflaredState(pidDir);
    expect(state.kind).toBe("stale-pid-process");
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
    // The dist Ollama proxy module destructures `spawnSync` at
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
