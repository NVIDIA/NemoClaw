// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Mocked unit coverage for the Bearer-token enforcement and header-stripping
// contract of scripts/ollama-auth-proxy.js. The live E2E target
// (test/e2e/live/ollama-auth-proxy.test.ts) exercises the same boundary but
// needs a real Ollama install plus a model pull; this pins the security-
// critical request-handler behavior hermetically.
//
// The proxy script is a standalone IIFE that binds a listener at load, so it
// cannot be required as a handler. Instead we spawn it as a real child process
// (unmodified production code) on an ephemeral port, point it at a tiny
// in-process stub HTTP backend, and drive real requests through it. No network
// beyond loopback; every server and child process has an awaited cleanup owner.

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

import { test as it } from "./helpers/owned-test-resources";

import {
  freePort,
  request,
  startBackend,
  startProxy,
  terminate,
  waitForProxyReadiness,
} from "./ollama-auth-proxy-handler-helpers.ts";

const TOKEN = "unit-test-secret-token";

describe("ollama-auth-proxy request handler", () => {
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  let proxy: ChildProcess | undefined;
  let proxyPort = 0;

  beforeEach(async () => {
    backend = await startBackend();
    proxyPort = await freePort();
    proxy = await startProxy(proxyPort, backend.port, TOKEN);
  });

  afterEach(async () => {
    await terminate(proxy);
    proxy = undefined;
    await new Promise<void>((resolve) => backend?.server.close(() => resolve()));
    backend = undefined;
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await request(proxyPort, { path: "/api/generate", method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(backend?.captured).toHaveLength(0);
  });

  it("returns 401 when the Bearer token is wrong", async () => {
    const res = await request(proxyPort, { path: "/api/generate", auth: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    expect(backend?.captured).toHaveLength(0);
  });

  it("returns 401 for unauthenticated /api/tags — no health-check bypass (#3338)", async () => {
    const res = await request(proxyPort, { path: "/api/tags" });
    expect(res.status).toBe(401);
    expect(backend?.captured).toHaveLength(0);
  });

  it("returns 401 for unauthenticated POST /api/tags (#3338)", async () => {
    const res = await request(proxyPort, { path: "/api/tags", method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(backend?.captured).toHaveLength(0);
  });

  it("forwards to the backend on a correct Bearer token and strips authorization + host headers", async () => {
    const res = await request(proxyPort, {
      path: "/v1/chat/completions",
      method: "POST",
      auth: `Bearer ${TOKEN}`,
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(backend?.captured).toHaveLength(1);
    const forwarded = backend?.captured[0];
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.url).toBe("/v1/chat/completions");
    // The auth header must never reach Ollama, and the client Host
    // (example.invalid) must be dropped so it does not override the backend.
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.headers.host).not.toBe("example.invalid");
  });

  it("returns 401 without crashing on a non-ASCII auth header of equal length but different byte length (#4820)", async () => {
    // "Bearer " + a multi-byte character string whose JS .length equals the
    // expected string's .length but whose UTF-8 byte length differs. A naive
    // string/length gate that fed unequal-length buffers to timingSafeEqual
    // would throw and crash the 0.0.0.0-bound proxy.
    const expected = `Bearer ${TOKEN}`;
    const prefix = "Bearer ";
    const restLen = expected.length - prefix.length;
    const multiByte = prefix + "é".repeat(restLen);
    expect(multiByte.length).toBe(expected.length);
    expect(Buffer.byteLength(multiByte)).not.toBe(Buffer.byteLength(expected));

    const res = await request(proxyPort, { path: "/api/tags", auth: multiByte });
    expect(res.status).toBe(401);
    expect(backend?.captured).toHaveLength(0);

    // The proxy must still be alive and serve a subsequent valid request.
    const ok = await request(proxyPort, { path: "/api/tags", auth: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(proxy?.exitCode).toBeNull();
  });

  it("returns 502 when the backend connection fails", async () => {
    // Kill the backend so the forward connection is refused; a valid token
    // then reaches the backend request that errors → 502.
    await new Promise<void>((resolve) => backend?.server.close(() => resolve()));
    const res = await request(proxyPort, { path: "/api/tags", auth: `Bearer ${TOKEN}` });
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/Ollama backend error/);
    expect(proxy?.exitCode).toBeNull();
  });
});

describe("ollama-auth-proxy process ownership", () => {
  it("reaps the proxy before reporting a readiness failure", async ({
    onTestFinished,
    resources,
  }) => {
    const readinessRejector = resources.ownServer(net.createServer((socket) => socket.destroy()));
    await new Promise<void>((resolve, reject) => {
      readinessRejector.once("error", reject);
      readinessRejector.listen(0, "127.0.0.1", resolve);
    });
    const readinessPort = (readinessRejector.address() as AddressInfo).port;
    const proxyPort = await freePort();
    let spawned: ChildProcess | undefined;
    onTestFinished(() => terminate(spawned));

    await expect(
      startProxy(proxyPort, 1, TOKEN, {
        onSpawn: (child) => {
          spawned = child;
        },
        readinessPort,
        readinessTimeoutMs: 100,
      }),
    ).rejects.toThrow("proxy did not start in time");

    expect(spawned).toBeDefined();
    expect(spawned?.signalCode).toBe("SIGTERM");
    expect(spawned?.stdout?.destroyed).toBe(true);
  });

  it("destroys a stalled readiness request and removes child listeners", async ({
    onTestFinished,
  }) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const destroy = vi.fn();
    const end = vi.fn();
    const request = Object.assign(new EventEmitter(), {
      destroy,
      end,
    }) as unknown as http.ClientRequest;
    const requestSpy = vi.spyOn(http, "request").mockReturnValue(request);
    onTestFinished(() => requestSpy.mockRestore());

    await expect(waitForProxyReadiness(child, 1, { readinessTimeoutMs: 10 })).rejects.toThrow(
      "proxy did not start in time",
    );

    expect(end).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("rejects a child spawn error and removes readiness listeners", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    const readiness = waitForProxyReadiness(child, 1, { readinessTimeoutMs: 1_000 });

    child.emit("error", spawnError);

    await expect(readiness).rejects.toBe(spawnError);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("escalates a SIGTERM-ignoring child and awaits close", async ({ onTestFinished }) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    onTestFinished(() => terminate(child));
    await once(child.stdout!, "data");

    await terminate(child);

    expect(child.signalCode).toBe("SIGKILL");
    expect(child.stdout?.destroyed).toBe(true);
  });
});
