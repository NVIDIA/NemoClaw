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
// beyond loopback; both servers and the child are torn down in afterEach.

import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROXY_SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "ollama-auth-proxy.js");
const TOKEN = "unit-test-secret-token";

interface BackendCapture {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** Start a loopback stub backend that records the request it received. */
function startBackend(): Promise<{
  server: http.Server;
  port: number;
  captured: BackendCapture[];
}> {
  const captured: BackendCapture[] = [];
  const server = http.createServer((req, res) => {
    captured.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: { ...req.headers },
    });
    // Drain the body so piped client requests complete cleanly.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, models: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, captured });
    });
  });
}

/** Grab an ephemeral free TCP port, then release it for the proxy to bind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** Spawn the real proxy script and wait until its listener accepts a connection. */
async function startProxy(
  proxyPort: number,
  backendPort: number,
  token: string,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      ...process.env,
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(proxyPort),
      OLLAMA_BACKEND_PORT: String(backendPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy did not start in time")), 5_000);
    const tryConnect = (): void => {
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/", method: "GET" },
        (res) => {
          res.resume();
          clearTimeout(timer);
          resolve();
        },
      );
      req.on("error", () => setTimeout(tryConnect, 100));
      req.end();
    };
    child.once("exit", (code) => reject(new Error(`proxy exited early with code ${code}`)));
    tryConnect();
  });
  return child;
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface ProxyResponse {
  status: number;
  body: string;
}

/** Issue a real request through the proxy on loopback. */
function request(
  proxyPort: number,
  options: { method?: string; path?: string; auth?: string; body?: string },
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: "example.invalid" };
    if (options.auth !== undefined) headers.authorization = options.auth;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: options.path ?? "/api/tags",
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

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
