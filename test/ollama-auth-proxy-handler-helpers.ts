// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for ollama-auth-proxy-handler.test.ts. The stub backend,
// free-port probe, child-process proxy launcher/terminator, and the loopback
// request driver all branch, so they live here to keep the test body linear.

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { type ChildProcessOwner, ownChildProcess } from "./helpers/child-process-lifecycle.ts";

export const PROXY_SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "ollama-auth-proxy.mts",
);
const proxyOwners = new WeakMap<ChildProcess, ChildProcessOwner>();

export interface BackendCapture {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export type StartProxyOptions = {
  onSpawn?: (child: ChildProcess) => void;
  readinessPort?: number;
  readinessTimeoutMs?: number;
};

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

export function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
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

export function waitForProxyReadiness(
  child: ChildProcess,
  proxyPort: number,
  options: Pick<StartProxyOptions, "readinessPort" | "readinessTimeoutMs"> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest: http.ClientRequest | undefined;
    let retryTimer: NodeJS.Timeout | undefined;

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (retryTimer) clearTimeout(retryTimer);
      child.off("error", handleChildError);
      child.off("exit", handleChildExit);
      const request = activeRequest;
      activeRequest = undefined;
      request?.destroy();
      complete();
    };
    const handleChildError = (error: Error): void => finish(() => reject(error));
    const handleChildExit = (code: number | null): void =>
      finish(() => reject(new Error(`proxy exited early with code ${code}`)));
    const timeout = setTimeout(
      () => finish(() => reject(new Error("proxy did not start in time"))),
      options.readinessTimeoutMs ?? 5_000,
    );
    const tryConnect = (): void => {
      if (settled) return;
      const request = http.request(
        {
          host: "127.0.0.1",
          port: options.readinessPort ?? proxyPort,
          path: "/",
          method: "GET",
        },
        (res) => {
          activeRequest = undefined;
          res.resume();
          finish(resolve);
        },
      );
      activeRequest = request;
      request.once("error", () => {
        if (activeRequest === request) activeRequest = undefined;
        if (!settled) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            tryConnect();
          }, 100);
        }
      });
      request.end();
    };

    child.once("error", handleChildError);
    child.once("exit", handleChildExit);
    tryConnect();
  });
}

/** Spawn the real proxy script and wait until its listener accepts a connection. */
export async function startProxy(
  proxyPort: number,
  backendPort: number,
  token: string,
  options: StartProxyOptions = {},
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
  const owner = ownChildProcess(child, { forceTimeoutMs: 2_000, gracefulTimeoutMs: 2_000 });
  proxyOwners.set(child, owner);
  try {
    options.onSpawn?.(child);
    await waitForProxyReadiness(child, proxyPort, options);
    return child;
  } catch (error) {
    try {
      await owner.terminate();
    } catch {
      // Cleanup failure must not replace the proxy startup failure.
    } finally {
      proxyOwners.delete(child);
    }
    throw error;
  }
}

export async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  const owner = proxyOwners.get(child) ?? ownChildProcess(child);
  try {
    await owner.terminate();
  } finally {
    proxyOwners.delete(child);
  }
}

export async function forceKill(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  const hasExited = child.exitCode !== null || child.signalCode !== null;
  if (hasExited && child.stdio.every((stream) => stream === null || stream?.destroyed)) return;
  const closed = once(child, "close");
  if (!hasExited) child.kill("SIGKILL");
  await closed;
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
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
