// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  launchForwardService,
  type ForwardServiceTarget,
} from "./forward-service";

const target: ForwardServiceTarget = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "demo",
  localHost: "127.0.0.1",
  localPort: 18_789,
  targetHost: "127.0.0.1",
  targetPort: 18_789,
};
const stableProcessIdentity = (pid: number): string => `start-${String(pid)}`;

describe("OpenShell forward service", () => {
  it("builds the direct ForwardTcp command with explicit gateway authority", () => {
    expect(buildForwardServiceArgs(target)).toEqual([
      "--gateway",
      "nemoclaw",
      "--workspace",
      "default",
      "forward",
      "service",
      "demo",
      "--target-port",
      "18789",
      "--target-host",
      "127.0.0.1",
      "--local",
      "127.0.0.1:18789",
    ]);
  });

  it("builds the direct ForwardTcp command for a selected non-default workspace", () => {
    expect(buildForwardServiceArgs({ ...target, workspace: "review-workspace" })).toContain(
      "review-workspace",
    );
  });

  it("detaches the OpenShell child and waits for its local port", () => {
    const unref = vi.fn();
    const spawnDetached = vi.fn(() => ({ pid: 41, unref }));
    let probes = 0;

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => true,
      isReachable: () => ++probes >= 3,
      isProcessRunning: () => true,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      target.executable,
      buildForwardServiceArgs(target),
      expect.any(Object),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("refuses an occupied port without launching or adopting its listener", () => {
    const spawnDetached = vi.fn();

    expect(() => launchForwardService(target, { isReachable: () => true, spawnDetached })).toThrow(
      /already occupied/u,
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("stops a running service that remains unbound at the deadline (#11084)", () => {
    const unboundTarget = { ...target, localPort: 18_791, targetPort: 18_791 };
    let running = true;
    const stopProcess = vi.fn(() => {
      running = false;
    });
    expect(() =>
      launchForwardService(unboundTarget, {
        describeState: () => "SANDBOX BIND PORT PID STATUS",
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => running,
        isReachable: () => false,
        maxAttempts: 1,
        sleep: () => {},
        spawnDetached: () => ({ pid: 42, unref: () => {} }),
        stopProcess,
        timeoutMs: 0,
      }),
    ).toThrow(/was stopped after failing to bind.*forward list: SANDBOX BIND PORT PID STATUS/u);
    expect(stopProcess).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("retries only after the prior service process exited (#11084)", () => {
    const spawnDetached = vi
      .fn()
      .mockReturnValueOnce({ pid: 51, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 52, unref: vi.fn() });
    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => true,
      isProcessRunning: (pid) => pid === 52,
      isReachable: () => spawnDetached.mock.calls.length === 2,
      retryDelayMs: 0,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the timed-out service cannot be stopped (#11084)", () => {
    const settlingTarget = { ...target, localPort: 18_790, targetPort: 18_790 };
    const spawnDetached = vi.fn(() => ({ pid: 61, unref: vi.fn() }));
    const stopProcess = vi.fn();

    expect(() =>
      launchForwardService(settlingTarget, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => true,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
        stopProcess,
        stopTimeoutMs: 0,
        timeoutMs: 0,
      }),
    ).toThrow(/process 61.*could not stop.*refusing to signal or retry/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
    expect(stopProcess.mock.calls).toEqual([
      [61, "SIGTERM"],
      [61, "SIGKILL"],
    ]);
  });

  it("confirms exit after escalating a timed-out service to SIGKILL (#11084)", () => {
    const signals: NodeJS.Signals[] = [];
    let killChecks = 0;

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => (signals.at(-1) === "SIGKILL" ? ++killChecks < 2 : true),
        isReachable: () => false,
        maxAttempts: 1,
        sleep: () => {},
        spawnDetached: () => ({ pid: 62, unref: vi.fn() }),
        stopProcess: (_pid, signal) => signals.push(signal),
        stopTimeoutMs: 1_000,
        timeoutMs: 0,
      }),
    ).toThrow(/was stopped after failing to bind/u);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(killChecks).toBe(2);
  });

  it("does not signal or retry after the forward PID is reused (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ pid: 63, unref: vi.fn() }));
    const stopProcess = vi.fn();
    let identityReads = 0;

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: () => (++identityReads === 1 ? "original" : "replacement"),
        isProcessRunning: () => true,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
        stopProcess,
        timeoutMs: 0,
      }),
    ).toThrow(/process 63 changed identity.*refusing to signal or retry/u);
    expect(stopProcess).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("refuses an unknown listener that appears before a safe retry (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ pid: 71, unref: vi.fn() }));
    let probes = 0;

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => ++probes >= 3,
        retryDelayMs: 0,
        sleep: () => {},
        spawnDetached,
        timeoutMs: 1_000,
      }),
    ).toThrow(/became occupied.*refusing to adopt/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("refuses a reachable listener not owned by the launched process (#11084)", () => {
    let running = true;
    let probes = 0;
    const stopProcess = vi.fn(() => {
      running = false;
    });

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => false,
        isProcessRunning: () => running,
        isReachable: () => ++probes >= 3,
        sleep: () => {},
        spawnDetached: () => ({ pid: 72, unref: vi.fn() }),
        stopProcess,
        timeoutMs: 1_000,
      }),
    ).toThrow(/became reachable.*owned by another process.*refused to report success/u);
    expect(stopProcess).toHaveBeenCalledWith(72, "SIGTERM");
  });

  it.runIf(process.platform === "linux")(
    "tracks the spawned process by its Linux start time (#11084)",
    () => {
      let probes = 0;

      launchForwardService(target, {
        isListenerOwned: () => true,
        isReachable: () => ++probes >= 3,
        spawnDetached: () => ({ pid: process.pid, unref: vi.fn() }),
      });

      expect(probes).toBe(3);
    },
  );

  it.runIf(process.platform === "darwin")(
    "stops and retries a spawned process using its macOS start time (#11084)",
    () => {
      let running = true;
      let spawnCount = 0;
      const stopProcess = vi.fn(() => {
        running = false;
      });
      const spawnDetached = vi.fn(() => {
        spawnCount += 1;
        running = true;
        return { pid: process.pid, unref: vi.fn() };
      });

      launchForwardService(target, {
        isListenerOwned: () => true,
        isProcessRunning: () => running,
        isReachable: () => spawnCount === 2,
        retryDelayMs: 0,
        sleep: () => {},
        spawnDetached,
        stopProcess,
        timeoutMs: 0,
      });

      expect(spawnDetached).toHaveBeenCalledTimes(2);
      expect(stopProcess).toHaveBeenCalledOnce();
      expect(stopProcess).toHaveBeenCalledWith(process.pid, "SIGTERM");
    },
  );

  it("does not retry when the service returns no process identity (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    expect(() =>
      launchForwardService(target, {
        describeState: () => {
          throw new Error("forward list failed");
        },
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
      }),
    ).toThrow(/no process identity.*forward list: <unavailable>/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });
});
