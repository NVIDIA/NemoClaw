// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for ollama-auth-proxy-handler.test.ts. The stub backend,
// free-port probe, child-process proxy launcher/terminator, and the loopback
// request driver all branch, so they live here to keep the test body linear.

import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const PROXY_SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "ollama-auth-proxy.js",
);

export interface BackendCapture {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** Start a loopback stub backend that records the request it received. */
export function startBackend(): Promise<{
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
export function freePort(): Promise<number> {
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
export async function startProxy(
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
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("proxy did not start in time"));
    }, 5_000);
    const tryConnect = (): void => {
      if (settled) return;
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/", method: "GET" },
        (res) => {
          res.resume();
          settled = true;
          clearTimeout(timer);
          resolve();
        },
      );
      req.on("error", () => {
        if (!settled) setTimeout(tryConnect, 100);
      });
      req.end();
    };
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`proxy exited early with code ${code}`));
    });
    tryConnect();
  });
  return child;
}

export async function terminate(child: ChildProcess | undefined): Promise<void> {
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

export interface ProxyResponse {
  status: number;
  body: string;
}

/** Issue a real request through the proxy on loopback. */
export function request(
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
