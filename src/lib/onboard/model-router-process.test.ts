// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findModelRouterPidForPort, stopModelRouterProcess } from "./model-router-process";

const ROUTER_ARGS = ["/opt/model-router", "proxy", "--port", "4000"];

describe("findModelRouterPidForPort", () => {
  it("returns the PID when a model-router proxy is found via direct proc scan (#5169)", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "4000"]
          : null,
      listProcPids: () => [1, 100, 12345, 99999],
    });
    expect(pid).toBe(12345);
  });

  it("returns the PID when model-router is Python-interpreted through args[1] (#5169)", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? [
              "/home/user/.nemoclaw/model-router-venv/bin/python",
              "/home/user/.nemoclaw/model-router-venv/bin/model-router",
              "proxy",
              "--port",
              "4000",
            ]
          : null,
      listProcPids: () => [1, 100, 12345, 99999],
    });
    expect(pid).toBe(12345);
  });

  it("returns null when no model-router is found on that port", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "9999"]
          : null,
      listProcPids: () => [12345],
    });
    expect(pid).toBe(null);
  });

  it("returns null when listProcPids returns an empty list", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: () => null,
      listProcPids: () => [],
    });
    expect(pid).toBe(null);
  });

  it("returns the first matching PID when multiple model-routers are present", () => {
    const pid = findModelRouterPidForPort(4000, {
      readProcCommandLine: (p) => {
        if (p === 100) return ["/opt/model-router", "proxy", "--port", "4000"];
        if (p === 200) return ["/opt/model-router", "proxy", "--port", "4000"];
        return null;
      },
      listProcPids: () => [50, 100, 200],
    });
    expect(pid).toBe(100);
  });
});

describe("stopModelRouterProcess", () => {
  it("returns only after the owned process and health endpoint stop", async () => {
    let running = true;
    let healthy = true;
    const signals: NodeJS.Signals[] = [];

    await stopModelRouterProcess(123, 4000, {
      isRunning: () => running,
      readCommandLine: () => ROUTER_ARGS,
      isHealthy: async () => healthy,
      kill: (_pid, signal) => {
        signals.push(signal);
        running = false;
        healthy = false;
      },
      sleep: async () => {},
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("refuses to signal a PID that no longer belongs to the router", async () => {
    const signals: NodeJS.Signals[] = [];

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => ["/usr/bin/unrelated-service", "--port", "4000"],
        isHealthy: async () => true,
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
      }),
    ).rejects.toThrow("it is not the model-router proxy");
    expect(signals).toEqual([]);
  });

  it("fails closed when SIGTERM cannot be delivered", async () => {
    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => ROUTER_ARGS,
        isHealthy: async () => true,
        kill: () => {
          throw new Error("EPERM");
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("Failed to send SIGTERM");
  });

  it("does not escalate when a process survives SIGTERM without a PID-stable handle", async () => {
    const signals: NodeJS.Signals[] = [];

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => ROUTER_ARGS,
        isHealthy: async () => true,
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
      }),
    ).rejects.toThrow("refusing PID-based SIGKILL");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("sends no escalation signal when PID ownership changes during graceful shutdown", async () => {
    let ownershipChecks = 0;
    const signals: NodeJS.Signals[] = [];

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => {
          ownershipChecks += 1;
          return ownershipChecks === 1 ? ROUTER_ARGS : ["/usr/bin/unrelated-service"];
        },
        isHealthy: async () => false,
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
      }),
    ).rejects.toThrow("ownership changed during shutdown");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does not signal a replacement that takes the PID after final ownership observation", async () => {
    let ownershipChecks = 0;
    let replacementOwnsPid = false;
    const routerSignals: NodeJS.Signals[] = [];
    const replacementSignals: NodeJS.Signals[] = [];

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => {
          ownershipChecks += 1;
          if (ownershipChecks === 2) replacementOwnsPid = true;
          return ROUTER_ARGS;
        },
        isHealthy: async () => true,
        kill: (_pid, signal) => {
          (replacementOwnsPid ? replacementSignals : routerSignals).push(signal);
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("refusing PID-based SIGKILL");

    expect(ownershipChecks).toBe(2);
    expect(routerSignals).toEqual(["SIGTERM"]);
    expect(replacementSignals).toEqual([]);
  });

  it("does not declare success when the PID exits but the endpoint survives", async () => {
    let running = true;

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => running,
        readCommandLine: () => ROUTER_ARGS,
        isHealthy: async () => true,
        kill: () => {
          running = false;
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("port 4000 remains healthy");
  });
});
