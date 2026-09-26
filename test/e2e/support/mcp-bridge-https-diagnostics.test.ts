// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startFakeMcpHttpsServer } from "../live/mcp-bridge-servers.ts";
import { shouldRetryMcpDiscoveryAfterRestart } from "../live/mcp-bridge-tool-discovery.ts";
import { createMcpFixtureTls } from "../fixtures/mcp-fixture-tls.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const { tls: fixtureTls, close: closeFixtureTls } = createMcpFixtureTls();
afterAll(closeFixtureTls);
describe("MCP HTTPS transport diagnostics", () => {
  it("bounds stalled diagnostic persistence so later owned cleanup still runs", async () => {
    let started!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startFakeMcpHttpsServer({
      secret: "diagnostic-secret",
      tls: fixtureTls,
      onCloseDiagnostics: () => {
        started();
        return pending;
      },
    });
    const cleanup = new CleanupRegistry();
    const later = vi.fn();
    cleanup.add("release follow-up test resource", later);
    cleanup.add("close HTTPS fixture", () => server.close());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const completion = cleanup.runAll();
    let reconnect: net.Socket | undefined;
    try {
      await writing;
      reconnect = net.connect(server.port, "127.0.0.1");
      const connection = await new Promise<string>((resolve) => {
        reconnect!.once("connect", () => resolve("connected"));
        reconnect!.once("error", (error: NodeJS.ErrnoException) => resolve(String(error.code)));
      });
      expect(connection).toBe("ECONNREFUSED");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(later).toHaveBeenCalledOnce();
      expect(await completion).toEqual({
        passed: ["release follow-up test resource"],
        failures: [
          {
            name: "close HTTPS fixture",
            message: expect.stringContaining("diagnostic persistence timed out"),
          },
        ],
      });
    } finally {
      release();
      reconnect?.destroy();
      await completion;
      vi.useRealTimers();
    }
  });

  it("records fixed TLS categories and closes before stalled or failed diagnostic persistence", async () => {
    const failure = new Error("artifact unavailable");
    let rejectWrite!: (error: Error) => void;
    const write = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    // An earlier assertion can enter teardown before close() observes this promise.
    void write.catch(() => undefined);
    const persist = vi.fn(() => write);
    const server = await startFakeMcpHttpsServer({
      secret: "diagnostic-secret",
      tls: fixtureTls,
      onCloseDiagnostics: persist,
    });
    const client = net.connect(server.port, "127.0.0.1");
    let reconnect: net.Socket | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      client.on("error", () => {});
      client.resume();
      const closed = new Promise<void>((resolve) => {
        client.once("close", () => resolve());
      });
      client.end("GET /injected-sensitive-marker HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await closed;
      await expect.poll(() => server.diagnostics().tlsClientErrors.ERR_SSL_HTTP_REQUEST).toBe(1);
      expect(server.diagnostics()).toEqual({
        secureConnections: 0,
        requestHeaders: 0,
        requestBodiesComplete: 0,
        tlsClientErrors: {
          ERR_SSL_HTTP_REQUEST: 1,
          ERR_SSL_WRONG_VERSION_NUMBER: 0,
          ERR_SSL_UNEXPECTED_EOF_WHILE_READING: 0,
          ECONNRESET: 0,
          OTHER: 0,
        },
      });
      closing = server.close().then(
        () => null,
        (error: unknown) => error,
      );
      await expect.poll(() => persist.mock.calls.length).toBe(1);
      reconnect = net.connect(server.port, "127.0.0.1");
      const connection = await new Promise<string>((resolve) => {
        reconnect!.once("connect", () => resolve("connected"));
        reconnect!.once("error", (error: NodeJS.ErrnoException) => resolve(String(error.code)));
      });
      expect(connection).toBe("ECONNREFUSED");
      rejectWrite(failure);
      expect(await closing).toBe(failure);
      expect(persist).toHaveBeenCalledWith(server.diagnostics());
      await expect(server.close()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: "ERR_SERVER_NOT_RUNNING" }), failure],
      });
    } finally {
      rejectWrite(failure);
      client.destroy();
      reconnect?.destroy();
      await closing;
      persist.mockResolvedValue(undefined);
      await server.close().catch((error: NodeJS.ErrnoException) => {
        expect(error).toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
      });
    }
  });

  it("records a slow POST arrival before its body completes", async () => {
    const secret = "slow-request-secret";
    const persist = vi.fn(async () => undefined);
    const server = await startFakeMcpHttpsServer({
      secret,
      tls: fixtureTls,
      onCloseDiagnostics: persist,
    });
    let closing: Promise<void> | undefined;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const observationOffset = server.observations.length;
    let resolveResponse!: (status: number) => void;
    let rejectResponse!: (error: Error) => void;
    const responseStatus = new Promise<number>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const observedStatus = responseStatus.then(
      (status) => ({ ok: true, status }) as const,
      (error: unknown) => ({ error, ok: false }) as const,
    );
    const slowRequest = https.request(
      `https://127.0.0.1:${server.port}/mcp`,
      {
        method: "POST",
        ca: fixtureTls.cert,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolveResponse(response.statusCode ?? 0));
      },
    );
    slowRequest.on("error", rejectResponse);
    try {
      slowRequest.write(body.slice(0, 1));

      await expect.poll(() => server.observations.length).toBe(observationOffset + 1);
      const arrival = server.observations[observationOffset];
      expect(server.requests).toHaveLength(0);
      expect(server.diagnostics()).toMatchObject({
        secureConnections: 1,
        requestHeaders: 1,
        requestBodiesComplete: 0,
      });
      expect(arrival).toMatchObject({
        method: "POST",
        path: "/mcp",
        auth: `Bearer ${secret}`,
        body: "",
      });
      expect(
        shouldRetryMcpDiscoveryAfterRestart(server.observations.slice(observationOffset)),
      ).toBe(false);

      closing = server.close();
      slowRequest.end(body.slice(1));
      expect(await observedStatus).toEqual({ ok: true, status: 200 });
      await closing;
      expect(server.requests).toHaveLength(1);
      expect(server.observations[observationOffset]).toBe(arrival);
      expect(server.requests[0]).toBe(arrival);
      expect(arrival).toMatchObject({ body, rpcMethod: "initialize" });
      expect(server.diagnostics()).toMatchObject({
        secureConnections: 1,
        requestHeaders: 1,
        requestBodiesComplete: 1,
      });
      expect(persist).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledWith(server.diagnostics());
      const copied = server.diagnostics();
      copied.requestHeaders = 99;
      copied.tlsClientErrors.OTHER = 99;
      expect(server.diagnostics().requestHeaders).toBe(1);
      expect(server.diagnostics().tlsClientErrors.OTHER).toBe(0);
    } finally {
      slowRequest.destroy();
      await (closing ?? server.close());
    }
  });
});

it.each([
  [
    "openssl",
    (failure: Error) =>
      vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
        throw failure;
      }),
  ],
  [
    "read",
    (failure: Error) =>
      vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
        throw failure;
      }),
  ],
] as const)("removes partial TLS material after %s failure", (_stage, inject) => {
  const failure = new Error("certificate creation failed");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tls-failure-test-"));
  const directory = path.join(parent, "certificate");
  const mkdir = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
    fs.mkdirSync(directory);
    return directory;
  });
  const injected = inject(failure);
  try {
    expect(() => createMcpFixtureTls()).toThrow(failure);
    expect(fs.existsSync(directory)).toBe(false);
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "openssl",
      expect.any(Array),
      expect.objectContaining({ timeout: 20_000, killSignal: "SIGKILL" }),
    );
  } finally {
    injected.mockRestore();
    mkdir.mockRestore();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
