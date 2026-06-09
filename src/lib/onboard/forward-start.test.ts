// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildDetachedForwardStartSpawn,
  looksLikeForwardPortConflict,
  runDetachedForwardStartWithDiagnostics,
  runDetachedForwardStartWithPortReleaseRetries,
} from "../../../dist/lib/onboard/forward-start";

// Build an `openshell forward list`-shaped output for the given live entries.
// Mirrors the column layout (SANDBOX BIND PORT PID STATUS) that
// `getOccupiedPorts` parses, so the helper recognises the forward as live.
function forwardListWith(
  entries: Array<{ sandbox: string; port: number; status?: string }>,
): string {
  const header = "SANDBOX   BIND        PORT   PID    STATUS";
  const rows = entries.map(
    (e) => `${e.sandbox}  127.0.0.1   ${e.port}   1234   ${e.status ?? "running"}`,
  );
  return [header, ...rows].join("\n");
}

describe("runDetachedForwardStartWithDiagnostics", () => {
  it("returns ok as soon as the forward appears in the list", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([])) // first poll: nothing yet
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.pid).toBe(42);
    expect(spawn).toHaveBeenCalledTimes(1);
    // First poll missed → one sleep before the second poll observed the entry.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("ignores entries that belong to a different sandbox", () => {
    const fetchList = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 50, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("reports timeout when the forward never appears", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.diagnostic).toMatch(/forward did not appear in list within 30ms/);
  });

  it("surfaces spawn errors immediately without polling", () => {
    const fetchList = vi.fn();
    const spawn = vi.fn().mockReturnValue({ error: new Error("ENOENT: openshell not found") });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn-error");
    expect(result.diagnostic).toMatch(/ENOENT/);
    expect(fetchList).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preflights argv[0] and short-circuits on a missing openshell binary", () => {
    const fetchList = vi.fn().mockReturnValue("");
    const sleep = vi.fn();
    // Real `buildDetachedForwardStartSpawn` checks `fs.accessSync(argv[0],
    // X_OK)` before spawning, so a missing binary surfaces as a synchronous
    // spawn-error instead of relying on Node's async `error` event (which
    // cannot fire while the helper is sleeping inside spawnSync).
    const spawn = buildDetachedForwardStartSpawn(["/nonexistent/openshell-binary-for-test"]);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 5_000, pollIntervalMs: 5, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn-error");
    expect(result.diagnostic).toMatch(/ENOENT|EACCES|no such file|permission denied/i);
    // No polling should have happened; the helper returned at the spawn
    // preflight step.
    expect(fetchList).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("invokes onProgress while waiting for the forward to appear", () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fetchList = vi.fn().mockReturnValue("");
      const spawn = vi.fn().mockReturnValue({ pid: 42 });
      const sleep = vi.fn().mockImplementation((ms) => {
        now += ms;
      });
      const onProgress = vi.fn();

      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        {
          overallTimeoutMs: 120_000,
          pollIntervalMs: 1_000,
          sleepMs: sleep,
          onProgress,
          progressIntervalMs: 30_000,
        },
      );

      expect(result.ok).toBe(false);
      expect(onProgress).toHaveBeenCalled();
      const calls = onProgress.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls[0][0].elapsedMs).toBeGreaterThanOrEqual(30_000);
      expect(result.diagnostic).toMatch(/forward did not appear in list within 120000ms/);
      expect(result.diagnostic).toMatch(/last forward list: <empty>/);
    } finally {
      Date.now = realNow;
    }
  });

  it("surfaces persistent fetchForwardList failures in the timeout diagnostic", () => {
    const fetchList = vi.fn().mockImplementation(() => {
      throw new Error("gateway transport: connection refused");
    });
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.diagnostic).toMatch(/openshell forward list failed/);
    expect(result.diagnostic).toMatch(/connection refused/);
  });

  it("treats fetchForwardList exceptions as transient and keeps polling", () => {
    const fetchList = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("gateway not reachable yet");
      })
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(true);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("clears a transient fetch error from the diagnostic when a later poll succeeds", () => {
    const fetchList = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transient gateway: connection refused");
      })
      .mockReturnValue("");
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.diagnostic).not.toMatch(/openshell forward list failed/);
  });

  it("SIGTERMs the detached child on timeout", () => {
    const fetchList = vi.fn().mockReturnValue("");
    const spawn = vi.fn().mockReturnValue({ pid: 4242 });
    const sleep = vi.fn();
    const realKill = process.kill;
    const killSpy = vi.fn();
    // Replace process.kill so the test does not actually try to signal pid 4242.
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;
    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 20, pollIntervalMs: 10, sleepMs: sleep },
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("timeout");
      expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("SIGTERMs the detached child on a port-conflict diagnostic", () => {
    // Spawn writes an EADDRINUSE line to the stderr file descriptor so the
    // first poll iteration reads it back and trips the conflict branch.
    const fetchList = vi.fn().mockReturnValue("");
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(stderr, "listen tcp 0.0.0.0:18789: bind: address already in use\n");
      return { pid: 8888 };
    });
    const sleep = vi.fn();
    const realKill = process.kill;
    const killSpy = vi.fn();
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;
    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 1_000, pollIntervalMs: 10, sleepMs: sleep },
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("spawn-conflict");
      expect(killSpy).toHaveBeenCalledWith(8888, "SIGTERM");
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("does not SIGTERM when spawn never produced a pid", () => {
    const fetchList = vi.fn();
    const spawn = vi.fn().mockReturnValue({ error: new Error("ENOENT") });
    const sleep = vi.fn();
    const realKill = process.kill;
    const killSpy = vi.fn();
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;
    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 1_000, pollIntervalMs: 10, sleepMs: sleep },
      );
      expect(result.reason).toBe("spawn-error");
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });
});

describe("runDetachedForwardStartWithPortReleaseRetries", () => {
  it("retries after a port-conflict diagnostic, then succeeds", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([])) // first attempt: never appears
      .mockReturnValueOnce(forwardListWith([])) // (timeout settles)
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const beforeRetry = vi.fn();
    // First spawn surfaces a port-conflict in its diagnostic synthesised via
    // an Error message; the second spawn succeeds and the forward appears.
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ error: new Error("EADDRINUSE: address already in use") })
      .mockReturnValueOnce({ pid: 99 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep, maxRetries: 3 },
    );

    expect(result.ok).toBe(true);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the failure does not look like a port conflict", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const beforeRetry = vi.fn();
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { overallTimeoutMs: 20, pollIntervalMs: 10, sleepMs: sleep, maxRetries: 3 },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after maxRetries even if conflict diagnostics persist", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const beforeRetry = vi.fn();
    const spawn = vi
      .fn()
      .mockReturnValue({ error: new Error("EADDRINUSE: address already in use") });
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithPortReleaseRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { overallTimeoutMs: 20, pollIntervalMs: 10, sleepMs: sleep, maxRetries: 2 },
    );

    expect(result.ok).toBe(false);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("looksLikeForwardPortConflict", () => {
  it("matches the common port-in-use signals", () => {
    expect(
      looksLikeForwardPortConflict("listen tcp 0.0.0.0:18789: bind: address already in use"),
    ).toBe(true);
    expect(looksLikeForwardPortConflict("EADDRINUSE")).toBe(true);
    expect(looksLikeForwardPortConflict("port 18789 in use")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(looksLikeForwardPortConflict("transport: connection refused")).toBe(false);
    expect(looksLikeForwardPortConflict("")).toBe(false);
  });
});
