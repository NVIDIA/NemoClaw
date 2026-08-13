// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  findModelRouterPidForPort,
  getRouterHealthSnapshot,
  stopModelRouterProcess,
} from "./model-router-process";

async function withHealthServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("getRouterHealthSnapshot (#8962)", () => {
  it("captures the /health body alongside a 2xx status", async () => {
    const body = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [{ error: "AuthenticationError: bad key" }],
    });
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      },
      async (port) => {
        const snapshot = await getRouterHealthSnapshot(port);
        expect(snapshot).toEqual({ healthy: true, body });
      },
    );
  });

  it("reports unhealthy with the body for a non-2xx response", async () => {
    await withHealthServer(
      (_req, res) => {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("router warming up");
      },
      async (port) => {
        const snapshot = await getRouterHealthSnapshot(port);
        expect(snapshot).toEqual({ healthy: false, body: "router warming up" });
      },
    );
  });

  it("reports unhealthy with no body when the connection is reset", async () => {
    const server = http.createServer();
    server.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const snapshot = await getRouterHealthSnapshot(port);
      expect(snapshot).toEqual({ healthy: false, body: null });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("settles at the wall-clock deadline with the partial body of a trickling response", async () => {
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"healthy_endpoints":[],"unhealthy_endpoints":[{"error":"partial');
        // Never end the response; the wall-clock deadline must settle it.
      },
      async (port) => {
        const snapshot = await getRouterHealthSnapshot(port, 300);
        expect(snapshot.healthy).toBe(true);
        expect(snapshot.body).toContain('"error":"partial');
      },
    );
  });

  it("settles at the capture cap with the truncated body prefix", async () => {
    const oversized = `{"unhealthy_endpoints":[{"error":"big"}],"pad":"${"x".repeat(70 * 1024)}"}`;
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(oversized);
      },
      async (port) => {
        const snapshot = await getRouterHealthSnapshot(port);
        expect(snapshot.healthy).toBe(true);
        expect(snapshot.body?.length).toBe(64 * 1024);
        expect(snapshot.body).toContain('"error":"big"');
      },
    );
  });
});

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
  it("returns when the recorded PID does not report as running and the health endpoint is not healthy", async () => {
    const isHealthy = vi.fn(async () => false);
    const kill = vi.fn();

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => false,
        isHealthy,
        kill,
      }),
    ).resolves.toBeUndefined();

    expect(isHealthy).toHaveBeenCalledWith(4000, 1000);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses replacement when the recorded PID does not report as running but the health endpoint remains healthy", async () => {
    const kill = vi.fn();

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => false,
        isHealthy: async () => true,
        kill,
      }),
    ).rejects.toThrow("PID 123 no longer reports as running but port 4000 remains healthy");

    expect(kill).not.toHaveBeenCalled();
  });

  it("returns only after the recorded PID does not report as running and the health endpoint is not healthy", async () => {
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
    ).rejects.toThrow("could not send SIGTERM");
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
    ).rejects.toThrow("refuses PID-based SIGKILL");
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

  it("does not send SIGKILL when a replacement owns the PID at the final command-line check", async () => {
    let ownershipChecks = 0;
    let replacementOwnsPid = false;
    const routerSignals: NodeJS.Signals[] = [];
    const replacementSignals: NodeJS.Signals[] = [];

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => true,
        readCommandLine: () => {
          ownershipChecks += 1;
          replacementOwnsPid ||= ownershipChecks === 2;
          return ROUTER_ARGS;
        },
        isHealthy: async () => true,
        kill: (_pid, signal) => {
          (replacementOwnsPid ? replacementSignals : routerSignals).push(signal);
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("refuses PID-based SIGKILL");

    expect(ownershipChecks).toBe(2);
    expect(routerSignals).toEqual(["SIGTERM"]);
    expect(replacementSignals).toEqual([]);
  });

  it("does not report success when the PID does not report as running but the health endpoint remains healthy", async () => {
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
