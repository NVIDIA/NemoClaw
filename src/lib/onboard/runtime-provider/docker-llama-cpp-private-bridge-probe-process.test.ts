// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  PRIVATE_BRIDGE_PROBE_CONNECT_EXIT,
  PRIVATE_BRIDGE_PROBE_HTTP_EXIT,
  PRIVATE_BRIDGE_PROBE_TIMEOUT_EXIT,
  parseLlamaCppPrivateBridgeProbeArguments,
  runLlamaCppPrivateBridgeProbe,
  type LlamaCppPrivateBridgeProbeAttempt,
} from "./docker-llama-cpp-private-bridge-probe-process";

describe("parseLlamaCppPrivateBridgeProbeArguments", () => {
  it("accepts an exact host loopback health address", () => {
    expect(
      parseLlamaCppPrivateBridgeProbeArguments(["http://127.0.0.1:8081/health", "30"]),
    ).toEqual({ url: "http://127.0.0.1:8081/health", timeoutSeconds: 30 });
  });

  it.each([
    ["https://127.0.0.1:8081/health", "30"],
    ["http://0.0.0.0:8081/health", "30"],
    ["http://127.0.0.1:8081/status", "30"],
    ["http://127.0.0.1:8081/health?probe=1", "30"],
    ["http://user@127.0.0.1:8081/health", "30"],
  ])("rejects the non-loopback or off-route address %s", (url, timeout) => {
    expect(() => parseLlamaCppPrivateBridgeProbeArguments([url, timeout])).toThrow(
      /exact http:\/\/127\.0\.0\.1/u,
    );
  });

  it.each([
    [["http://127.0.0.1:8081/health"]],
    [["http://127.0.0.1:8081/health", "30", "extra"]],
    [["not-a-url", "30"]],
    [["http://127.0.0.1:8081/health", "soon"]],
    [["http://127.0.0.1:8081/health", "0"]],
    [["http://127.0.0.1:8081/health", "1.5"]],
    [["http://127.0.0.1:99999/health", "30"]],
  ])("rejects malformed arguments %j", (argv) => {
    expect(() => parseLlamaCppPrivateBridgeProbeArguments(argv)).toThrow();
  });
});

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds: number) => {
      current += milliseconds;
    }),
  };
}

describe("runLlamaCppPrivateBridgeProbe", () => {
  it("succeeds on the first healthy response", async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<LlamaCppPrivateBridgeProbeAttempt>>()
      .mockResolvedValue({ kind: "response", status: 200 });

    const exit = await runLlamaCppPrivateBridgeProbe(
      { url: "http://127.0.0.1:8081/health", timeoutSeconds: 30 },
      { attempt, now: clock.now, sleep: clock.sleep },
    );

    expect(exit).toBe(0);
    expect(attempt).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledWith("http://127.0.0.1:8081/health", 30_000);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable server response until the bridge reports healthy", async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<LlamaCppPrivateBridgeProbeAttempt>>()
      .mockResolvedValueOnce({ kind: "response", status: 502 })
      .mockResolvedValueOnce({ kind: "response", status: 500 })
      .mockResolvedValue({ kind: "response", status: 200 });

    const exit = await runLlamaCppPrivateBridgeProbe(
      { url: "http://127.0.0.1:8081/health", timeoutSeconds: 30 },
      { attempt, now: clock.now, sleep: clock.sleep },
    );

    expect(exit).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops without retrying a non-retryable HTTP status", async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<LlamaCppPrivateBridgeProbeAttempt>>()
      .mockResolvedValue({ kind: "response", status: 404 });

    const exit = await runLlamaCppPrivateBridgeProbe(
      { url: "http://127.0.0.1:8081/health", timeoutSeconds: 30 },
      { attempt, now: clock.now, sleep: clock.sleep },
    );

    expect(exit).toBe(PRIVATE_BRIDGE_PROBE_HTTP_EXIT);
    expect(attempt).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("reports a connection failure with the curl connect exit after the deadline", async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<
        (_url: string, timeoutMilliseconds: number) => Promise<LlamaCppPrivateBridgeProbeAttempt>
      >()
      .mockResolvedValue({ kind: "connect" });

    const exit = await runLlamaCppPrivateBridgeProbe(
      { url: "http://127.0.0.1:8081/health", timeoutSeconds: 3 },
      { attempt, now: clock.now, sleep: clock.sleep },
    );

    expect(exit).toBe(PRIVATE_BRIDGE_PROBE_CONNECT_EXIT);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(attempt.mock.calls.map(([, timeout]) => timeout)).toEqual([3_000, 2_000, 1_000]);
  });

  it("reports an exhausted probe budget with the curl timeout exit", async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async (_url: string, timeoutMilliseconds: number) => {
      await clock.sleep(timeoutMilliseconds);
      return { kind: "timeout" } as const;
    });

    const exit = await runLlamaCppPrivateBridgeProbe(
      { url: "http://127.0.0.1:8081/health", timeoutSeconds: 3 },
      { attempt, now: clock.now },
    );

    expect(exit).toBe(PRIVATE_BRIDGE_PROBE_TIMEOUT_EXIT);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it.each([
    ["completes", (response: http.ServerResponse) => response.writeHead(200).end("ok")],
    ["never ends", (response: http.ServerResponse) => response.writeHead(200).write("ok")],
  ])("probes a real loopback server whose healthy response %s", async (_kind, respond) => {
    const server = http.createServer((_request, response) => {
      respond(response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const exit = await runLlamaCppPrivateBridgeProbe({
        url: `http://127.0.0.1:${String(port)}/health`,
        timeoutSeconds: 2,
      });
      expect(exit).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
