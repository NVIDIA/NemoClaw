// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "./metrics.js";
import { createMetricsRequestHandler, resolveMetricsPort } from "./server.js";

function callHandler(
  registry: MetricsRegistry,
  path: string,
  {
    method = "GET",
    headers = { host: "localhost" },
    logger,
  }: {
    method?: string;
    headers?: IncomingHttpHeaders;
    logger?: Parameters<typeof createMetricsRequestHandler>[1];
  } = {},
) {
  const req = {
    url: path,
    method,
    headers,
  } as IncomingMessage;
  const responseBody: string[] = [];
  const res = {
    writeHead: vi.fn(),
    end: vi.fn((body?: string) => {
      if (body) {
        responseBody.push(body);
      }
    }),
  } as unknown as ServerResponse;

  createMetricsRequestHandler(registry, logger)(req, res);

  const writeHead = vi.mocked(res.writeHead);
  const [status, responseHeaders] = writeHead.mock.calls[0] as [
    number,
    Record<string, string> | undefined,
  ];
  return {
    status,
    headers: responseHeaders,
    body: responseBody.join(""),
  };
}

describe("metrics server", () => {
  it("serves Prometheus metrics at /metrics", () => {
    const registry = new MetricsRegistry(() => true);
    registry.incrementCounter("test_counter_total", { status: "success" });

    const response = callHandler(registry, "/metrics");

    expect(response.status).toBe(200);
    expect(response.headers?.["Content-Type"]).toContain("text/plain");
    expect(response.body).toContain('test_counter_total{status="success"} 1');
  });

  it("does not depend on the request Host header when parsing the metrics path", () => {
    const registry = new MetricsRegistry(() => true);
    registry.incrementCounter("test_counter_total");

    const response = callHandler(registry, "/metrics", { headers: { host: "http://[::1" } });

    expect(response.status).toBe(200);
    expect(response.body).toContain("test_counter_total 1");
  });

  it("returns 405 for unsupported HTTP methods", () => {
    const response = callHandler(new MetricsRegistry(() => true), "/metrics", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers?.Allow).toBe("GET");
    expect(response.body).toBe("method not allowed\n");
  });

  it("returns 400 for malformed request URLs", () => {
    const response = callHandler(new MetricsRegistry(() => true), "http://[::1");

    expect(response.status).toBe(400);
    expect(response.body).toBe("bad request\n");
  });

  it("returns 404 for non-metrics paths", () => {
    const response = callHandler(new MetricsRegistry(() => true), "/ready");
    expect(response.status).toBe(404);
    expect(response.body).toBe("not found\n");
  });

  it("returns 500 when metrics rendering fails", () => {
    const registry = new MetricsRegistry(() => true);
    const logger = { warn: vi.fn() };
    vi.spyOn(registry, "renderPrometheus").mockImplementation(() => {
      throw new Error("render failed");
    });

    const response = callHandler(registry, "/metrics", { logger });

    expect(response.status).toBe(500);
    expect(response.headers?.["Cache-Control"]).toBe("no-store");
    expect(response.body).toBe("internal server error\n");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("render failed"));
  });

  it("rejects invalid metrics ports", () => {
    expect(() => resolveMetricsPort({ NEMOCLAW_METRICS_PORT: "not-a-port" })).toThrow(
      /NEMOCLAW_METRICS_PORT/,
    );
  });
});
