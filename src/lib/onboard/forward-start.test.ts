// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildDetachedForwardStartSpawn,
  looksLikeForwardListenerStartFailure,
  looksLikeForwardPortConflict,
  looksLikeUntrackedForward,
  runDetachedForwardStartWithDiagnostics,
  runDetachedForwardStartWithRetries,
} from "./forward-start";

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

const SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC = `Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"
`;

function readinessHandoffSpawn(rejections: number) {
  const diagnostics = [
    ...Array<string>(rejections).fill(SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC),
    "",
  ];
  return vi.fn(({ stderr }: { stderr: number }) => {
    fs.writeSync(stderr, diagnostics.shift() ?? "");
    return {};
  });
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

  it("classifies a final OpenShell readiness rejection before returning timeout (#10155)", () => {
    let now = 0;
    const realNow = Date.now;
    const trustedReadFileSync = fs.readFileSync.bind(fs);
    let stderrReads = 0;
    Date.now = () => now;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      const isForwardStderr = String(file).endsWith("nemoclaw-forward-start.err");
      stderrReads += Number(isForwardStderr);
      return isForwardStderr
        ? stderrReads === 1
          ? ""
          : SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC
        : trustedReadFileSync(file, options as never);
    }) as typeof fs.readFileSync);

    try {
      const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
      const isPortListening = vi.fn().mockReturnValue(false);

      const result = runDetachedForwardStartWithDiagnostics(
        vi.fn().mockReturnValue({}),
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        {
          overallTimeoutMs: 1,
          pollIntervalMs: 1,
          sleepMs: (ms) => {
            now += ms;
          },
          isPortListening,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("listener-start-failure");
      expect(result.diagnostic).toMatch(/message: "sandbox is not ready"/);
      expect(result.diagnostic).not.toContain("forward did not appear in list within");
      expect(fetchList).toHaveBeenCalledOnce();
      expect(isPortListening).toHaveBeenCalledOnce();
    } finally {
      readSpy.mockRestore();
      Date.now = realNow;
    }
  });

  it("keeps a final readiness rejection terminal when forward ownership is unknown (#10155)", () => {
    let now = 0;
    const realNow = Date.now;
    const trustedReadFileSync = fs.readFileSync.bind(fs);
    let stderrReads = 0;
    Date.now = () => now;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      const isForwardStderr = String(file).endsWith("nemoclaw-forward-start.err");
      stderrReads += Number(isForwardStderr);
      return isForwardStderr
        ? stderrReads === 1
          ? ""
          : SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC
        : trustedReadFileSync(file, options as never);
    }) as typeof fs.readFileSync);

    try {
      const isPortListening = vi.fn().mockReturnValue(false);
      const result = runDetachedForwardStartWithDiagnostics(
        vi.fn().mockReturnValue({}),
        vi.fn(() => {
          throw new Error("gateway transport unavailable");
        }),
        { port: 18789, sandboxName: "my-sandbox" },
        {
          overallTimeoutMs: 1,
          pollIntervalMs: 1,
          sleepMs: (ms) => {
            now += ms;
          },
          isPortListening,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("timeout");
      expect(result.diagnostic).toMatch(/openshell forward list failed/);
      expect(isPortListening).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      Date.now = realNow;
    }
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

  it("confirms an untracked forward via the live-port probe (#6099)", () => {
    // openshell established the SSH tunnel but could not track it, so the
    // forward never appears in `openshell forward list`. The spawn writes
    // openshell's "not tracked" notice to stderr; with the local port live,
    // the helper should confirm the forward instead of timing out.
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "! Could not discover backgrounded SSH process; forward may be running but is not tracked\n",
      );
      return { pid: 777 };
    });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(true);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok-port-live");
    expect(result.pid).toBe(777);
    expect(isPortListening).toHaveBeenCalledWith(18789);
  });

  it("prefers a port conflict over the untracked-forward fallback (#6099)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "EADDRINUSE: address already in use; forward may be running but is not tracked\n",
      );
      return { pid: 779 };
    });
    const isPortListening = vi.fn().mockReturnValue(true);
    const realKill = process.kill;
    (process as { kill: typeof process.kill }).kill = vi.fn() as unknown as typeof process.kill;

    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: vi.fn(), isPortListening },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("spawn-conflict");
      expect(isPortListening).not.toHaveBeenCalled();
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("rate-limits failed live-port probes while waiting (#6099)", () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
      const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
        fs.writeSync(stderr, "forward may be running but is not tracked\n");
        return { pid: 780 };
      });
      const isPortListening = vi.fn().mockReturnValue(false);

      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        {
          overallTimeoutMs: 16_000,
          pollIntervalMs: 500,
          sleepMs: (ms) => {
            now += ms;
          },
          isPortListening,
        },
      );

      expect(result.reason).toBe("timeout");
      expect(isPortListening).toHaveBeenCalledTimes(4);
    } finally {
      Date.now = realNow;
    }
  });

  it("confirms a mux-delegated forward via the live-port probe when ssh exits under ControlMaster (#6099)", () => {
    // Under `Host *` / `ControlMaster auto` ssh config, the spawned ssh client
    // hands the -L forward to the ControlMaster mux daemon and exits; openshell
    // 0.0.72+ reports the exit as a startup failure even though the mux daemon
    // holds the listener and the dashboard is serving.
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "Error:   × ssh process started but local forward listener was not reachable\n" +
          "  ╰─▶ ssh exited before local forward listener opened on 127.0.0.1:18789\n",
      );
      return { pid: 781 };
    });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(true);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 10_000, pollIntervalMs: 10, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok-port-live");
    expect(result.pid).toBe(781);
    expect(isPortListening).toHaveBeenCalledWith(18789);
  });

  it("returns immediately when ssh exits and no ControlMaster listener is live (#7266)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(stderr, "ssh exited before local forward listener opened on 127.0.0.1:18789\n");
      return {};
    });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(false);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-start-failure");
    expect(isPortListening).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns immediately for openshell's listener timeout when the port remains closed (#7266)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "Error: ssh process started but local forward listener was not reachable\n" +
          "local forward listener did not open on 127.0.0.1:18789 within 10000ms\n",
      );
      return {};
    });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(false);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 180_000, pollIntervalMs: 500, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-start-failure");
    expect(result.diagnostic).not.toContain("forward did not appear in list within");
    expect(isPortListening).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects another sandbox's live row during listener-start failure (#7266)", () => {
    const fetchList = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "local forward listener did not open on 127.0.0.1:18789 within 10000ms\n",
      );
      return {};
    });
    const isPortListening = vi.fn().mockReturnValue(true);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 180_000, sleepMs: vi.fn(), isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-ownership-conflict");
    expect(isPortListening).not.toHaveBeenCalled();
  });

  it("does not accept a live port after an ownership lookup failure (#7266)", () => {
    const fetchList = vi.fn().mockImplementation(() => {
      throw new Error("gateway transport: access denied");
    });
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(stderr, "ssh exited before local forward listener opened on 127.0.0.1:18789\n");
      return { pid: 786 };
    });
    const isPortListening = vi.fn().mockReturnValue(true);
    const realKill = process.kill;
    const killSpy = vi.fn();
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;

    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 180_000, sleepMs: vi.fn(), isPortListening },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("listener-start-failure");
      expect(result.diagnostic).toMatch(/openshell forward list failed:.*access denied/i);
      expect(isPortListening).not.toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(786, "SIGTERM");
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("does not accept a live port when the ownership lookup returns null (#8522)", () => {
    const fetchList = vi.fn().mockReturnValue(null);
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(stderr, "ssh exited before local forward listener opened on 127.0.0.1:18789\n");
      return { pid: 790 };
    });
    const isPortListening = vi.fn().mockReturnValue(true);
    const realKill = process.kill;
    const killSpy = vi.fn();
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;

    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 180_000, sleepMs: vi.fn(), isPortListening },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("listener-start-failure");
      expect(result.diagnostic).toMatch(/openshell forward list failed:.*no forward list result/i);
      expect(isPortListening).not.toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(790, "SIGTERM");
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("rejects a live port without the established untracked-forward diagnostic (#7266)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "local forward listener did not open on 127.0.0.1:18789 within 10000ms\n",
      );
      return { pid: 787 };
    });
    const isPortListening = vi.fn().mockReturnValue(true);
    const realKill = process.kill;
    const killSpy = vi.fn();
    (process as { kill: typeof process.kill }).kill = killSpy as unknown as typeof process.kill;

    try {
      const result = runDetachedForwardStartWithDiagnostics(
        spawn,
        fetchList,
        { port: 18789, sandboxName: "my-sandbox" },
        { overallTimeoutMs: 180_000, sleepMs: vi.fn(), isPortListening },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("listener-ownership-conflict");
      expect(isPortListening).toHaveBeenCalledWith(18789);
      expect(killSpy).toHaveBeenCalledWith(787, "SIGTERM");
    } finally {
      (process as { kill: typeof process.kill }).kill = realKill;
    }
  });

  it("keeps waiting (then times out) when openshell reports untracked but the port is not live", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "Could not discover backgrounded SSH process; forward may be running but is not tracked\n",
      );
      return { pid: 778 };
    });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(false);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(isPortListening).toHaveBeenCalled();
  });

  it("does not run the post-spawn probe without a relevant diagnostic", () => {
    // A plain empty list must not trigger the post-spawn live-port probe. The
    // retry wrapper's separate pre-attempt probe is outside this helper.
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockReturnValue({ pid: 42 });
    const sleep = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(true);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      { overallTimeoutMs: 30, pollIntervalMs: 10, sleepMs: sleep, isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(isPortListening).not.toHaveBeenCalled();
  });

  it("rejects an untracked live-port fallback while the expected row is dead (#7140)", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchList = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789, status: "dead" }]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "Could not discover backgrounded SSH process; forward may be running but is not tracked\n",
      );
      return { pid: 788 };
    });
    const isPortListening = vi.fn().mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = runDetachedForwardStartWithDiagnostics(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      {
        overallTimeoutMs: 10_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          now += ms;
        },
        isPortListening,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dead-forward");
    expect(isPortListening).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(788, "SIGTERM");
  });
});

describe("runDetachedForwardStartWithRetries", () => {
  it("stops and retries an expected forward whose ANSI status stays dead (#7140)", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawn = vi.fn().mockReturnValueOnce({ pid: 41 }).mockReturnValueOnce({ pid: 42 });
    const fetchList = vi
      .fn()
      .mockImplementation(() =>
        spawn.mock.calls.length === 1
          ? forwardListWith([
              { sandbox: "my-sandbox", port: 18789, status: "\u001B[31mdead\u001B[0m" },
            ])
          : forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]),
      );
    const beforeRetry = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 10_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          now += ms;
        },
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(beforeRetry).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(41, "SIGTERM");
    expect(killSpy.mock.invocationCallOrder[0]).toBeLessThan(
      beforeRetry.mock.invocationCallOrder[0],
    );
    expect(killSpy).not.toHaveBeenCalledWith(42, expect.anything());
  });

  it("allows only one cleanup when the replacement forward also stays dead (#7140)", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawn = vi.fn().mockReturnValueOnce({ pid: 41 }).mockReturnValueOnce({ pid: 42 });
    const fetchList = vi
      .fn()
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789, status: "dead" }]));
    const beforeRetry = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 10_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          now += ms;
        },
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dead-forward");
    expect(beforeRetry).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, 41, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 42, "SIGTERM");
  });

  it("accepts an expected forward that recovers during the dead-state grace (#7140)", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawn = vi.fn().mockReturnValue({ pid: 41 });
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(
        forwardListWith([{ sandbox: "my-sandbox", port: 18789, status: "dead" }]),
      )
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const beforeRetry = vi.fn();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 10_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          now += ms;
        },
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does not clean up dead rows for another sandbox or port (#7140)", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawn = vi.fn().mockReturnValue({ pid: 41 });
    const fetchList = vi.fn().mockReturnValue(
      forwardListWith([
        { sandbox: "my-sandbox", port: 18790, status: "dead" },
        { sandbox: "other-sandbox", port: 18789, status: "dead" },
      ]),
    );
    const beforeRetry = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 3_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          now += ms;
        },
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

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

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 30,
        pollIntervalMs: 10,
        sleepMs: sleep,
        maxRetries: 3,
        isPortListening: vi.fn().mockReturnValue(false),
      },
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

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 20,
        pollIntervalMs: 10,
        sleepMs: sleep,
        maxRetries: 3,
        isPortListening: vi.fn().mockReturnValue(false),
      },
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

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 20,
        pollIntervalMs: 10,
        sleepMs: sleep,
        maxRetries: 2,
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(false);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("preserves a concurrent same-target replacement while retrying (#7266)", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([]))
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const spawn = vi
      .fn()
      .mockImplementationOnce(({ stderr }: { stderr: number }) => {
        fs.writeSync(
          stderr,
          "local forward listener did not open on 127.0.0.1:18789 within 10000ms\n",
        );
        return {};
      })
      .mockReturnValueOnce({ pid: 785 });
    const beforeRetry = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 180_000,
        pollIntervalMs: 500,
        sleepMs: vi.fn(),
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(true);
    // The second forward-list row can belong to a concurrent replacement.
    // Listener-failure retry must observe it without stopping by sandbox/port.
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("retries an OpenShell sandbox readiness rejection after a bounded settle delay", () => {
    const fetchList = vi
      .fn()
      .mockReturnValueOnce(forwardListWith([]))
      .mockReturnValue(forwardListWith([{ sandbox: "my-sandbox", port: 18789 }]));
    const events: string[] = [];
    const spawn = vi
      .fn()
      .mockImplementationOnce(({ stderr }: { stderr: number }) => {
        events.push("spawn-1");
        fs.writeSync(
          stderr,
          `Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"
`,
        );
        return { pid: 784 };
      })
      .mockImplementationOnce(() => {
        events.push("spawn-2");
        return { pid: 785 };
      });
    const beforeRetry = vi.fn();
    const sleep = vi.fn((ms: number) => {
      events.push(`sleep-${ms}`);
    });

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        sleepMs: sleep,
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(true);
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(events).toEqual(["spawn-1", "sleep-5000", "spawn-2"]);
  });

  it.each([
    [
      "fails",
      () => {
        throw new Error("gateway transport unavailable");
      },
    ],
    ["returns no result", () => null],
  ])(
    "does not retry a readiness handoff when the ownership lookup %s (#10155)",
    (_case, fetchForwardList) => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const spawn = readinessHandoffSpawn(1);
      const delays: number[] = [];

      const result = runDetachedForwardStartWithRetries(
        spawn,
        vi.fn(fetchForwardList),
        { port: 18789, sandboxName: "my-sandbox" },
        vi.fn(),
        {
          overallTimeoutMs: 1,
          pollIntervalMs: 1,
          sleepMs: (ms) => {
            delays.push(ms);
            now += ms;
          },
          isPortListening: vi.fn().mockReturnValue(false),
        },
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("timeout");
      expect(spawn).toHaveBeenCalledOnce();
      expect(delays).not.toContain(5_000);
    },
  );

  it("keeps retrying when four consecutive readiness handoffs are still settling", () => {
    const spawn = readinessHandoffSpawn(4);
    const fetchList = vi.fn(() =>
      spawn.mock.calls.length >= 5
        ? forwardListWith([{ sandbox: "my-sandbox", port: 18789 }])
        : forwardListWith([]),
    );
    const beforeRetry = vi.fn();
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        sleepMs: sleep,
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("stops after the independent sandbox readiness retry bound", () => {
    const spawn = readinessHandoffSpawn(13);
    const beforeRetry = vi.fn();
    const sleep = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      vi.fn().mockReturnValue(forwardListWith([])),
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        sleepMs: sleep,
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-start-failure");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(13);
    expect(sleep).toHaveBeenCalledTimes(12);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("does not retry a composite authentication diagnostic that mentions readiness", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const delays: number[] = [];
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        `Permission denied (publickey); previous attempt reported Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"
`,
      );
      return { pid: 784 };
    });

    const result = runDetachedForwardStartWithRetries(
      spawn,
      vi.fn().mockReturnValue(forwardListWith([])),
      { port: 18789, sandboxName: "my-sandbox" },
      vi.fn(),
      {
        overallTimeoutMs: 1_000,
        pollIntervalMs: 500,
        sleepMs: (ms) => {
          delays.push(ms);
          now += ms;
        },
        isPortListening: vi.fn().mockReturnValue(false),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(spawn).toHaveBeenCalledOnce();
    expect(delays).not.toContain(5_000);
  });

  it("preserves a ControlMaster listener created by the current attempt (#6099)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(stderr, "ssh exited before local forward listener opened on 127.0.0.1:18789\n");
      return { pid: 785 };
    });
    const beforeRetry = vi.fn();
    const isPortListening = vi
      .fn()
      .mockReturnValueOnce(false) // free before this attempt starts
      .mockReturnValueOnce(true); // mux owns the listener after ssh exits

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { isPortListening },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok-port-live");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(isPortListening).toHaveBeenCalledTimes(2);
  });

  it("stops after bounded retries when listener startup keeps failing (#7266)", () => {
    const fetchList = vi.fn().mockReturnValue(forwardListWith([]));
    const spawn = vi.fn().mockImplementation(({ stderr }: { stderr: number }) => {
      fs.writeSync(
        stderr,
        "local forward listener did not open on 127.0.0.1:18789 within 10000ms\n",
      );
      return {};
    });
    const beforeRetry = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      {
        overallTimeoutMs: 180_000,
        pollIntervalMs: 500,
        sleepMs: vi.fn(),
        isPortListening: vi.fn().mockReturnValue(false),
        maxRetries: 2,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-start-failure");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated authentication failures (#7266)", () => {
    const fetchList = vi.fn();
    const spawn = vi.fn().mockReturnValue({ error: new Error("Permission denied (publickey)") });
    const beforeRetry = vi.fn();

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { maxRetries: 3, isPortListening: vi.fn().mockReturnValue(false) },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn-error");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("never spawns over an arbitrary listener that predates the attempt (#7266)", () => {
    const fetchList = vi.fn();
    const spawn = vi.fn();
    const beforeRetry = vi.fn();
    const isPortListening = vi.fn().mockReturnValue(true);

    const result = runDetachedForwardStartWithRetries(
      spawn,
      fetchList,
      { port: 18789, sandboxName: "my-sandbox" },
      beforeRetry,
      { maxRetries: 2, isPortListening },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("listener-ownership-conflict");
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchList).not.toHaveBeenCalled();
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

describe("looksLikeForwardListenerStartFailure", () => {
  it("matches only definitive listener termination diagnostics", () => {
    expect(
      looksLikeForwardListenerStartFailure(
        `Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"`,
      ),
    ).toBe(true);
    expect(
      looksLikeForwardListenerStartFailure(
        "local forward listener did not open on 127.0.0.1:18789 within 10000ms",
      ),
    ).toBe(true);
    expect(
      looksLikeForwardListenerStartFailure(
        "ssh exited before local forward listener opened on 127.0.0.1:18789",
      ),
    ).toBe(true);
    expect(looksLikeForwardListenerStartFailure("Permission denied (publickey)")).toBe(false);
    expect(looksLikeForwardListenerStartFailure("gateway transport unavailable")).toBe(false);
    expect(
      looksLikeForwardListenerStartFailure(
        'Permission denied (publickey); previous attempt reported "sandbox is not ready"',
      ),
    ).toBe(false);
  });
});

describe("looksLikeUntrackedForward", () => {
  it("matches openshell's untracked-forward notice", () => {
    expect(
      looksLikeUntrackedForward(
        "! Could not discover backgrounded SSH process; forward may be running but is not tracked",
      ),
    ).toBe(true);
    expect(looksLikeUntrackedForward("forward may be running but is not tracked")).toBe(true);
  });

  it("matches openshell 0.0.72's mux-delegated ssh exit error (#6099)", () => {
    expect(
      looksLikeUntrackedForward(
        "Error:   × ssh process started but local forward listener was not reachable\n" +
          "  ╰─▶ ssh exited before local forward listener opened on 127.0.0.1:18789",
      ),
    ).toBe(true);
    expect(
      looksLikeUntrackedForward(
        "ssh exited before local forward listener opened on 127.0.0.1:8642",
      ),
    ).toBe(true);
  });

  it("returns false for unrelated diagnostics", () => {
    expect(looksLikeUntrackedForward("forward did not appear in list within 180000ms")).toBe(false);
    expect(looksLikeUntrackedForward("")).toBe(false);
  });
});
