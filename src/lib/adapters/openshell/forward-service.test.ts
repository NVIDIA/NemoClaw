// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  getForwardListenerOwnership,
  launchForwardService,
  parseForwardInstanceIdentity,
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

  it("accepts an owned listener without opening a ForwardTcp connection (#11084)", () => {
    const unref = vi.fn();
    let spawned = false;
    const spawnDetached = vi.fn(() => {
      spawned = true;
      return { pid: 41, unref };
    });
    const isReachable = vi.fn(() => {
      expect(spawned).toBe(false);
      return false;
    });

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => true,
      isReachable,
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
    expect(isReachable).toHaveBeenCalledTimes(2);
  });

  it("requires the owned listener to remain stable before callers connect (#11084)", () => {
    let ownershipChecks = 0;
    const sleep = vi.fn();

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => {
        ownershipChecks += 1;
        return ownershipChecks !== 10;
      },
      isProcessRunning: () => true,
      isReachable: () => false,
      sleep,
      spawnDetached: () => ({ pid: 43, unref: vi.fn() }),
      timeoutMs: 10_000,
    });

    expect(ownershipChecks).toBe(36);
    expect(sleep).toHaveBeenCalledTimes(35);
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
      isReachable: () => false,
      retryDelayMs: 0,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "phase transition",
      "Error:\n  × sandbox 'demo' is no longer ready (phase: creating); stopping service\n  ╰─▶ forward",
    ],
    ["explicit message", 'Error:\n  ╰─▶ message: "sandbox is not ready"'],
  ])(
    "retries an exact OpenShell sandbox readiness handoff on its bounded schedule [%s] (#11084)",
    (_case, diagnostic) => {
      const spawnDetached = vi
        .fn()
        .mockReturnValueOnce({
          pid: 53,
          readOutput: () => diagnostic,
          removeOutput: vi.fn(),
          unref: vi.fn(),
        })
        .mockReturnValueOnce({ pid: 54, unref: vi.fn() });
      const sleep = vi.fn();

      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: (pid) => pid === 54,
        isProcessRunning: (pid) => pid === 54,
        isReachable: () => false,
        maxSandboxReadyRetries: 1,
        sleep,
        spawnDetached,
      });

      expect(spawnDetached).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(5_000);
    },
  );

  it("does not classify a missing sandbox as a readiness handoff (#11084)", () => {
    const sleep = vi.fn();

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => false,
        maxAttempts: 1,
        sleep,
        spawnDetached: () => ({
          pid: 55,
          readOutput: () => "Error: sandbox 'demo' no longer exists; stopping service forward",
          removeOutput: vi.fn(),
          unref: vi.fn(),
        }),
      }),
    ).toThrow(/forward start: non-readiness OpenShell diagnostic/u);
    expect(sleep).not.toHaveBeenCalledWith(5_000);
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
    ).toThrow(/remained reachable.*refusing to adopt its listener or retry/u);
    expect(stopProcess).toHaveBeenCalledWith(72, "SIGTERM");
  });

  it.runIf(process.platform === "linux")(
    "tracks the spawned process by its Linux start time (#11084)",
    () => {
      const isReachable = vi.fn(() => false);

      launchForwardService(target, {
        isListenerOwned: () => true,
        isReachable,
        spawnDetached: () => ({ pid: process.pid, unref: vi.fn() }),
      });

      expect(isReachable).toHaveBeenCalledTimes(2);
    },
  );

  it.runIf(process.platform === "linux")(
    "proves listener ownership from Linux procfs without lsof (#11084)",
    async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address() as AddressInfo;
        expect(getForwardListenerOwnership(process.pid, address.port)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("distinguishes same-second POSIX processes by their launch token (#11084)", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";

    expect(
      parseForwardInstanceIdentity(
        `openshell ${"lstart=same ".repeat(2)}NEMOCLAW_FORWARD_INSTANCE_ID=${first}`,
      ),
    ).toBe(`${process.platform}:${first}`);
    expect(
      parseForwardInstanceIdentity(
        `openshell ${"lstart=same ".repeat(2)}NEMOCLAW_FORWARD_INSTANCE_ID=${second}`,
      ),
    ).toBe(`${process.platform}:${second}`);
  });

  it.runIf(process.platform === "darwin")(
    "stops and retries a spawned process after macOS identity verification (#11084)",
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
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => spawnCount === 2,
        isProcessRunning: () => running,
        isReachable: () => false,
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

  it("classifies OpenShell start output without exposing its contents (#11084)", () => {
    const removeOutput = vi.fn();
    let error: unknown;

    try {
      launchForwardService(target, {
        isProcessRunning: () => false,
        isReachable: () => false,
        maxAttempts: 1,
        sleep: () => {},
        spawnDetached: () => ({
          pid: 81,
          readOutput: () => "sandbox is not ready API_KEY=secret-value",
          removeOutput,
          unref: vi.fn(),
        }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/forward start: non-readiness OpenShell diagnostic/u);
    expect((error as Error).message).not.toContain("secret-value");
    expect(removeOutput).toHaveBeenCalledOnce();
  });
});
