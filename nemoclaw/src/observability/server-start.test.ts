// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

type ErrorHandler = (error: Error) => void;
type ListenCallback = () => void;
type CloseCallback = (error?: Error) => void;

interface FakeServer {
  errorHandler?: ErrorHandler;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  server: undefined as FakeServer | undefined,
}));

vi.mock("node:http", () => ({
  createServer: vi.fn(() => state.server),
}));

const { MetricsRegistry } = await import("./metrics.js");
const { resolveMetricsHost, resolveMetricsPort, startMetricsServer } = await import("./server.js");

function makeFakeServer({
  listenError,
  closeError,
}: {
  listenError?: Error;
  closeError?: Error;
} = {}): FakeServer {
  const server: FakeServer = {
    once: vi.fn((event: string, handler: ErrorHandler) => {
      if (event === "error") {
        server.errorHandler = handler;
      }
      return server;
    }),
    off: vi.fn(() => server),
    listen: vi.fn((_port: number, _host: string, callback: ListenCallback) => {
      if (listenError) {
        server.errorHandler?.(listenError);
      } else {
        callback();
      }
      return server;
    }),
    address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: 9191 })),
    close: vi.fn((callback: CloseCallback) => {
      callback(closeError);
      return server;
    }),
  };
  return server;
}

describe("startMetricsServer", () => {
  beforeEach(() => {
    state.server = makeFakeServer();
  });

  it("resolves default and custom bind settings", () => {
    expect(resolveMetricsPort({})).toBe(9090);
    expect(resolveMetricsPort({ NEMOCLAW_METRICS_PORT: "19191" })).toBe(19191);
    expect(resolveMetricsHost({})).toBe("127.0.0.1");
    expect(resolveMetricsHost({ NEMOCLAW_METRICS_HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
  });

  it("starts and closes the metrics server", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const server = await startMetricsServer({
      registry: new MetricsRegistry(() => true),
      logger,
      env: {
        NEMOCLAW_METRICS_HOST: "0.0.0.0",
        NEMOCLAW_METRICS_PORT: "0",
      },
    });

    expect(server.host).toBe("0.0.0.0");
    expect(server.port).toBe(9191);
    expect(logger.info).toHaveBeenCalledWith(
      "NemoClaw metrics endpoint listening at http://0.0.0.0:9191/metrics",
    );

    await server.close();
    expect(state.server?.close).toHaveBeenCalled();
  });

  it("rejects when listen fails", async () => {
    state.server = makeFakeServer({ listenError: new Error("port busy") });

    await expect(
      startMetricsServer({
        registry: new MetricsRegistry(() => true),
        logger: { info: vi.fn(), warn: vi.fn() },
        env: { NEMOCLAW_METRICS_PORT: "9090" },
      }),
    ).rejects.toThrow("port busy");
  });

  it("rejects when close fails", async () => {
    state.server = makeFakeServer({ closeError: new Error("close failed") });

    const server = await startMetricsServer({
      registry: new MetricsRegistry(() => true),
      logger: { info: vi.fn(), warn: vi.fn() },
      env: { NEMOCLAW_METRICS_PORT: "0" },
    });

    await expect(server.close()).rejects.toThrow("close failed");
  });
});
