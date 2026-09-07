// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  forwardServiceInternals,
  getForwardListenerOwnership,
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

  it("detaches the OpenShell child and waits for its owned local listener (#11084)", () => {
    const unref = vi.fn();
    const spawnDetached = vi.fn(() => ({ pid: 41, unref }));
    const isReachable = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => true,
      isProcessRunning: () => true,
      isReachable,
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

  it("uses the selected OpenShell configuration without exposing credentials (#11084)", () => {
    let launchedEnvironment: NodeJS.ProcessEnv | undefined;
    const spawnDetached = vi.fn(
      (_executable: string, _args: readonly string[], environment: NodeJS.ProcessEnv) => {
        launchedEnvironment = environment;
        return { pid: 42, unref: vi.fn() };
      },
    );

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => true,
      isProcessRunning: () => true,
      isReachable: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      sleep: () => {},
      sourceEnvironment: {
        HOME: "/tmp/isolated-home",
        NVIDIA_INFERENCE_API_KEY: "secret-value",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
      },
      spawnDetached,
    });

    expect(launchedEnvironment).toMatchObject({
      HOME: "/tmp/isolated-home",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
    });
    expect(launchedEnvironment).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });

  it("refuses an occupied port without launching or adopting its listener", () => {
    const spawnDetached = vi.fn();

    expect(() => launchForwardService(target, { isReachable: () => true, spawnDetached })).toThrow(
      /already occupied/u,
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("does not accept a listener without proving the launched service owns it (#11084)", () => {
    let running = true;
    const stopProcess = vi.fn(() => {
      running = false;
    });

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => false,
        isProcessRunning: () => running,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ pid: 42, unref: () => {} }),
        stopProcess,
        timeoutMs: 0,
      }),
    ).toThrow(/did not become ready|owned|identity|adopt/u);
    expect(stopProcess).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("accepts delayed ownership only after the exact child survives a health-check window (#11084)", () => {
    let now = 0;
    let ownershipChecks = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => ++ownershipChecks >= 3,
      isProcessRunning: () => true,
      isReachable: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      sleep: (milliseconds) => {
        now += milliseconds;
      },
      spawnDetached: () => ({ pid: 43, unref: vi.fn() }),
      timeoutMs: 10_000,
    });

    expect(ownershipChecks).toBe(24);
    expect(now).toBe(2_300);
  });

  it("does not require every intermediate listener inspection to observe the owned socket (#11084)", () => {
    let now = 0;
    let ownershipChecks = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: () => ++ownershipChecks % 10 === 1,
      isProcessRunning: () => true,
      isReachable: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      sleep: (milliseconds) => {
        now += milliseconds;
      },
      spawnDetached: () => ({ pid: 44, unref: vi.fn() }),
      timeoutMs: 10_000,
    });

    expect(ownershipChecks).toBe(31);
    expect(now).toBe(3_000);
  });

  it("does not accept an unowned listener at the completion observation (#11084)", () => {
    let now = 0;
    let running = true;
    let ownershipChecks = 0;
    const stopProcess = vi.fn(() => {
      running = false;
    });
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => ++ownershipChecks === 1,
        isProcessRunning: () => running,
        isReachable: () => false,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
        spawnDetached: () => ({ pid: 45, unref: vi.fn() }),
        stopProcess,
        timeoutMs: 2_100,
      }),
    ).toThrow(/listener: absent/u);
    expect(stopProcess).toHaveBeenCalledWith(45, "SIGTERM");
  });

  it("does not accept an owned listener that still refuses connections (#11084)", () => {
    let now = 0;
    let running = true;
    const isReachable = vi.fn(() => false);
    const stopProcess = vi.fn(() => {
      running = false;
    });
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => true,
        isProcessRunning: () => running,
        isReachable,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
        spawnDetached: () => ({ pid: 46, unref: vi.fn() }),
        stopProcess,
        timeoutMs: 2_100,
      }),
    ).toThrow(/listener: owned; reachability: refused/u);
    expect(isReachable).toHaveBeenCalledTimes(3);
    expect(stopProcess).toHaveBeenCalledWith(46, "SIGTERM");
  });

  it("does not signal a process whose launch identity changed (#11084)", () => {
    let identityChecks = 0;
    const stopProcess = vi.fn();

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: () => (++identityChecks === 1 ? "original" : "replacement"),
        isListenerOwned: () => false,
        isProcessRunning: () => true,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ pid: 44, unref: vi.fn() }),
        stopProcess,
      }),
    ).toThrow(/changed identity.*refusing to signal or retry/u);
    expect(stopProcess).not.toHaveBeenCalled();
  });

  it("does not retry when an owned unready process cannot be stopped (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ pid: 45, unref: vi.fn() }));
    const stopProcess = vi.fn();

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => false,
        isProcessRunning: () => true,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
        stopProcess,
        stopTimeoutMs: 0,
        timeoutMs: 0,
      }),
    ).toThrow(/could not be stopped.*refusing to retry/u);
    expect(stopProcess.mock.calls).toEqual([
      [45, "SIGTERM"],
      [45, "SIGKILL"],
    ]);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("fails closed when OpenShell returns no process identity (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        spawnDetached,
      }),
    ).toThrow(/no process identity.*refusing to start a duplicate service/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("retries an exited service only for the exact sandbox creating handoff (#11084)", () => {
    const diagnostic =
      "Error:\n  × sandbox 'demo' is no longer ready (phase: creating); stopping service\n  ╰─▶ forward";
    const spawnDetached = vi
      .fn()
      .mockReturnValueOnce({
        pid: 51,
        readOutput: () => diagnostic,
        removeOutput: vi.fn(),
        unref: vi.fn(),
      })
      .mockReturnValueOnce({ pid: 52, removeOutput: vi.fn(), unref: vi.fn() });
    const onSandboxCreatingRetry = vi.fn();
    const sleep = vi.fn();

    launchForwardService(target, {
      getProcessIdentity: stableProcessIdentity,
      isListenerOwned: (pid) => pid === 52,
      isProcessRunning: (pid) => pid === 52,
      isReachable: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      maxSandboxCreatingRetries: 1,
      onSandboxCreatingRetry,
      sleep,
      spawnDetached,
      timeoutMs: 10_000,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(2);
    expect(onSandboxCreatingRetry).toHaveBeenCalledWith({
      attempt: 1,
      delayMs: 2_000,
      processId: 51,
      remainingMs: expect.any(Number),
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("classifies a creating handoff that exits before its identity can be read (#11084)", () => {
    const diagnostic =
      "sandbox 'demo' is no longer ready (phase: creating); stopping service forward";
    const spawnDetached = vi
      .fn()
      .mockReturnValueOnce({
        pid: 53,
        readOutput: () => diagnostic,
        removeOutput: vi.fn(),
        unref: vi.fn(),
      })
      .mockReturnValueOnce({ pid: 54, removeOutput: vi.fn(), unref: vi.fn() });

    launchForwardService(target, {
      getProcessIdentity: (pid) => (pid === 53 ? null : stableProcessIdentity(pid)),
      isListenerOwned: (pid) => pid === 54,
      isProcessRunning: (pid) => pid === 54,
      isReachable: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      maxSandboxCreatingRetries: 1,
      onSandboxCreatingRetry: () => {},
      sleep: () => {},
      spawnDetached,
      timeoutMs: 10_000,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "terminal phase",
      "sandbox 'demo' is no longer ready (phase: error); stopping service forward",
    ],
    [
      "different sandbox",
      "sandbox 'another' is no longer ready (phase: creating); stopping service forward",
    ],
    ["missing sandbox", "sandbox 'demo' no longer exists; stopping service forward"],
  ])("does not retry a terminal or unrelated start result [%s] (#11084)", (_case, diagnostic) => {
    const spawnDetached = vi.fn(() => ({
      pid: 61,
      readOutput: () => diagnostic,
      removeOutput: vi.fn(),
      unref: vi.fn(),
    }));

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
      }),
    ).toThrow(/non-readiness-diagnostic/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("refuses an unknown listener that appears before a safe retry (#11084)", () => {
    let probes = 0;
    const spawnDetached = vi.fn(() => ({
      pid: 71,
      readOutput: () =>
        "sandbox 'demo' is no longer ready (phase: creating); stopping service forward",
      removeOutput: vi.fn(),
      unref: vi.fn(),
    }));

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => ++probes >= 2,
        maxSandboxCreatingRetries: 1,
        sleep: () => {},
        spawnDetached,
      }),
    ).toThrow(/became occupied.*refusing to adopt/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("bounds repeated sandbox creating handoffs and records every attempt (#11084)", () => {
    const spawnDetached = vi.fn(() => ({
      pid: 72,
      readOutput: () =>
        "sandbox 'demo' is no longer ready (phase: creating); stopping service forward",
      removeOutput: vi.fn(),
      unref: vi.fn(),
    }));

    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => false,
        maxSandboxCreatingRetries: 2,
        onSandboxCreatingRetry: () => {},
        sleep: () => {},
        spawnDetached,
        timeoutMs: 10_000,
      }),
    ).toThrow(/attempts: 1=pid-72:sandbox-creating:listener-absent:reachability-not-checked/u);
    expect(spawnDetached).toHaveBeenCalledTimes(3);
  });

  it("fails when the detached service does not bind before the deadline", () => {
    let running = true;
    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isListenerOwned: () => false,
        isProcessRunning: () => running,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ pid: 81, unref: () => {} }),
        stopProcess: () => {
          running = false;
        },
        timeoutMs: 0,
      }),
    ).toThrow(/did not become ready/u);
  });

  it("classifies captured start output without exposing its contents (#11084)", () => {
    let error: unknown;
    const removeOutput = vi.fn();
    try {
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({
          pid: 82,
          readOutput: () => "terminal failure API_KEY=secret-value",
          removeOutput,
          unref: vi.fn(),
        }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("non-readiness-diagnostic");
    expect((error as Error).message).not.toContain("secret-value");
    expect(removeOutput).toHaveBeenCalledOnce();
  });

  it("records an exact OpenShell bind announcement without exposing raw output (#11084)", () => {
    expect(() =>
      launchForwardService(target, {
        getProcessIdentity: stableProcessIdentity,
        isProcessRunning: () => false,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({
          pid: 83,
          readOutput: () =>
            "✓ Forwarding 127.0.0.1:18789 -> 127.0.0.1:18789 in sandbox demo via gRPC",
          removeOutput: vi.fn(),
          unref: vi.fn(),
        }),
      }),
    ).toThrow(/forwarding-announced/u);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "bounds output retained by a long-running forward child (#11084)",
    async () => {
      const child = forwardServiceInternals.spawnForwardService(
        process.execPath,
        [
          "-e",
          'process.stdout.write("x".repeat(65536)); setInterval(() => process.stdout.write("later\\n"), 10);',
        ],
        process.env,
      );
      try {
        await vi.waitFor(
          () =>
            expect(child.readOutput?.()).toHaveLength(
              forwardServiceInternals.startOutputLimitBytes,
            ),
          { interval: 25, timeout: 2_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(child.readOutput?.()).toHaveLength(forwardServiceInternals.startOutputLimitBytes);
        child.removeOutput?.();
        expect(child.readOutput?.()).toBe("");
      } finally {
        child.removeOutput?.();
        expect(child.pid).toBeTypeOf("number");
        try {
          process.kill(child.pid as number, "SIGTERM");
        } catch {
          // The fixture may already have stopped after a failed assertion.
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "proves listener ownership from Linux procfs without connecting (#11084)",
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

  it.runIf(process.platform === "darwin")(
    "proves listener ownership from macOS lsof without connecting (#11084)",
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
});
