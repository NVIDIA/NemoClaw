// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  getRouterHealthSnapshot,
  inspectModelRouterProcessForPort,
  isRouterResponsive,
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
        expect(snapshot).toMatchObject({
          healthy: true,
          body,
          capturedBodyBytes: Buffer.byteLength(body),
          outcome: "complete",
          statusCode: 200,
        });
        expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
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
        expect(snapshot).toMatchObject({
          healthy: false,
          body: "router warming up",
          outcome: "complete",
          statusCode: 503,
        });
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
      expect(snapshot).toMatchObject({
        healthy: false,
        body: null,
        capturedBodyBytes: 0,
        outcome: "transport_error",
        statusCode: null,
      });
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
        expect(snapshot.healthy).toBe(false);
        expect(snapshot.body).toContain('"error":"partial');
        expect(snapshot).toMatchObject({ outcome: "timeout", statusCode: 200 });
      },
    );
  });

  it("aborts a pending semantic health response when startup no longer needs it (#12089)", async () => {
    let notifyRequest: () => void = () => undefined;
    const requestReceived = new Promise<void>((resolve) => {
      notifyRequest = resolve;
    });
    const controller = new AbortController();

    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"healthy_endpoints":[');
        notifyRequest();
      },
      async (port) => {
        const snapshotPromise = getRouterHealthSnapshot(port, 10_000, controller.signal);
        await requestReceived;
        controller.abort();
        await expect(snapshotPromise).resolves.toMatchObject({
          healthy: false,
          outcome: "aborted",
        });
      },
    );
  });

  it("reports the truncated body prefix after an oversized response ends", async () => {
    const oversized = `{"unhealthy_endpoints":[{"error":"big"}],"pad":"${"x".repeat(70 * 1024)}"}`;
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(oversized);
      },
      async (port) => {
        const snapshot = await getRouterHealthSnapshot(port);
        expect(snapshot.healthy).toBe(false);
        expect(snapshot.body?.length).toBe(64 * 1024);
        expect(snapshot.body).toContain('"error":"big"');
        expect(snapshot).toMatchObject({
          capturedBodyBytes: 64 * 1024,
          outcome: "body_limit",
          statusCode: 200,
        });
      },
    );
  });

  it("keeps consuming an oversized response until the wall-clock deadline (#12089)", async () => {
    let notifyBodyWritten: () => void = () => undefined;
    const bodyWritten = new Promise<void>((resolve) => {
      notifyBodyWritten = resolve;
    });
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("x".repeat(64 * 1024 + 1), notifyBodyWritten);
        // Never end the response; reaching the capture cap must not settle it.
      },
      async (port) => {
        const snapshotPromise = getRouterHealthSnapshot(port, 300);
        await bodyWritten;
        const snapshot = await snapshotPromise;
        expect(snapshot).toMatchObject({
          healthy: false,
          capturedBodyBytes: 64 * 1024,
          outcome: "timeout",
          statusCode: 200,
        });
        expect(snapshot.body?.length).toBe(64 * 1024);
      },
    );
  });

  it("treats a response exactly at the capture cap as complete", async () => {
    const body = "x".repeat(64 * 1024);
    await withHealthServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      },
      async (port) => {
        await expect(getRouterHealthSnapshot(port)).resolves.toMatchObject({
          healthy: true,
          body,
          capturedBodyBytes: 64 * 1024,
          outcome: "complete",
          statusCode: 200,
        });
      },
    );
  });

  it("checks liveness without waiting for a hanging semantic health response (#12089)", async () => {
    await withHealthServer(
      (req, res) => {
        switch (req.url) {
          case "/health/liveliness":
            res.writeHead(200);
            res.end("ok");
            break;
          case "/health":
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"healthy_endpoints":[');
            break;
        }
      },
      async (port) => {
        await expect(isRouterResponsive(port, 300)).resolves.toBe(true);
        await expect(getRouterHealthSnapshot(port, 50)).resolves.toMatchObject({
          healthy: false,
          outcome: "timeout",
          statusCode: 200,
        });
      },
    );
  });

  it("bounds liveness by wall-clock time while informational responses continue (#12089)", async () => {
    await withHealthServer(
      (_req, res) => {
        const activity = setInterval(() => res.writeProcessing(), 20);
        res.once("close", () => clearInterval(activity));
      },
      async (port) => {
        await expect(isRouterResponsive(port, 100)).resolves.toBe(false);
      },
    );
  });
});

const ROUTER_ARGS = ["/opt/model-router", "proxy", "--port", "4000"];

describe("inspectModelRouterProcessForPort", () => {
  it("returns the PID when a model-router proxy is found via direct proc scan (#5169)", () => {
    const result = inspectModelRouterProcessForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "4000"]
          : null,
      listProcPids: () => [1, 100, 12345, 99999],
    });
    expect(result).toEqual({ status: "found", pid: 12345 });
  });

  it("returns the PID when model-router is Python-interpreted through args[1] (#5169)", () => {
    const result = inspectModelRouterProcessForPort(4000, {
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
    expect(result).toEqual({ status: "found", pid: 12345 });
  });

  it("reports absence when no model-router is found on that port", () => {
    const result = inspectModelRouterProcessForPort(4000, {
      readProcCommandLine: (p) =>
        p === 12345
          ? ["/home/user/.nemoclaw/model-router-venv/bin/model-router", "proxy", "--port", "9999"]
          : null,
      listProcPids: () => [12345],
    });
    expect(result).toEqual({ status: "absent" });
  });

  it("reports absence when the process inventory is empty", () => {
    const result = inspectModelRouterProcessForPort(4000, {
      readProcCommandLine: () => null,
      listProcPids: () => [],
    });
    expect(result).toEqual({ status: "absent" });
  });

  it("reports an unavailable process inventory separately from absence", () => {
    const result = inspectModelRouterProcessForPort(4000, {
      listProcPids: () => {
        throw new Error("process inventory unavailable");
      },
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("returns the first matching PID when multiple model-routers are present", () => {
    const result = inspectModelRouterProcessForPort(4000, {
      readProcCommandLine: (p) => {
        if (p === 100) return ["/opt/model-router", "proxy", "--port", "4000"];
        if (p === 200) return ["/opt/model-router", "proxy", "--port", "4000"];
        return null;
      },
      listProcPids: () => [50, 100, 200],
    });
    expect(result).toEqual({ status: "found", pid: 100 });
  });
});

describe("stopModelRouterProcess", () => {
  it("returns when the recorded PID does not report as running and the liveness endpoint is unresponsive", async () => {
    const isResponsive = vi.fn(async () => false);
    const kill = vi.fn();

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => false,
        isResponsive,
        kill,
      }),
    ).resolves.toBeUndefined();

    expect(isResponsive).toHaveBeenCalledWith(4000, 1000);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses replacement when the recorded PID stops but the liveness endpoint responds", async () => {
    const kill = vi.fn();

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => false,
        isResponsive: async () => true,
        kill,
      }),
    ).rejects.toThrow("PID 123 no longer reports as running but port 4000 remains responsive");

    expect(kill).not.toHaveBeenCalled();
  });

  it("returns only after the recorded PID does not report as running and the liveness endpoint is unresponsive", async () => {
    let running = true;
    let healthy = true;
    const signals: NodeJS.Signals[] = [];

    await stopModelRouterProcess(123, 4000, {
      isRunning: () => running,
      readCommandLine: () => ROUTER_ARGS,
      isResponsive: async () => healthy,
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
        isResponsive: async () => true,
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
        isResponsive: async () => true,
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
        isResponsive: async () => true,
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
        isResponsive: async () => false,
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
        isResponsive: async () => true,
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

  it("does not report success when the PID stops but the liveness endpoint responds", async () => {
    let running = true;

    await expect(
      stopModelRouterProcess(123, 4000, {
        isRunning: () => running,
        readCommandLine: () => ROUTER_ARGS,
        isResponsive: async () => true,
        kill: () => {
          running = false;
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("port 4000 remains responsive");
  });
});
