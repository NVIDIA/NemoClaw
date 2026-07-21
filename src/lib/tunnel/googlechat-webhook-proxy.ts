// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildSubprocessEnv } from "../subprocess-env";

const PROCESS_MARKER = "nemoclaw-googlechat-webhook-proxy";
const PID_FILE = `${PROCESS_MARKER}.pid`;
const STATE_FILE = `${PROCESS_MARKER}.json`;
const LOG_FILE = `${PROCESS_MARKER}.log`;
const START_TIMEOUT_MS = 5000;

export type GooglechatWebhookProxyState =
  | { readonly running: false; readonly port: null; readonly upstreamPort: null }
  | { readonly running: true; readonly port: number; readonly upstreamPort: number };

const PROXY_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const http = require("node:http");

const upstreamPort = Number(process.env.NEMOCLAW_GOOGLECHAT_PROXY_UPSTREAM_PORT);
const stateFile = process.env.NEMOCLAW_GOOGLECHAT_PROXY_STATE_FILE;
const maxBodyBytes = 1024 * 1024;
const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 || !stateFile) {
  process.stderr.write("invalid Google Chat webhook proxy configuration\n");
  process.exit(1);
}

function filteredHeaders(headers) {
  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHop.has(name.toLowerCase()) && value !== undefined) filtered[name] = value;
  }
  return filtered;
}

function send(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message);
}

function forward(req, res, body) {
  const headers = filteredHeaders(req.headers);
  headers.host = "127.0.0.1:" + String(upstreamPort);
  headers["content-length"] = String(body.length);
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: upstreamPort,
    method: "POST",
    path: req.url,
    headers,
    agent: false,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, filteredHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });
  upstream.setTimeout(15000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => send(res, 502, "Bad Gateway\n"));
  upstream.end(body);
}

const server = http.createServer((req, res) => {
  let pathname = "";
  try {
    pathname = new URL(req.url || "", "http://localhost").pathname;
  } catch {}
  if (req.method !== "POST" || pathname !== "/googlechat") {
    req.resume();
    return send(res, 404, "Not Found\n");
  }

  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > maxBodyBytes) {
    req.resume();
    return send(res, 413, "Payload Too Large\n");
  }

  const chunks = [];
  let received = 0;
  let rejected = false;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > maxBodyBytes) {
      rejected = true;
      chunks.length = 0;
      send(res, 413, "Payload Too Large\n");
      return;
    }
    if (!rejected) chunks.push(chunk);
  });
  req.on("end", () => {
    if (!rejected) forward(req, res, Buffer.concat(chunks));
  });
  req.on("error", () => send(res, 400, "Bad Request\n"));
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 1000;
server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  fs.writeFileSync(stateFile, JSON.stringify({ port: address.port, upstreamPort }) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

function validatePort(port: number, label: string): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${String(port)}`);
  }
  return port;
}

function ensureStateDir(pidDir: string): void {
  mkdirSync(pidDir, { recursive: true, mode: 0o700 });
  chmodSync(pidDir, 0o700);
}

function readPositiveInteger(file: string): number | null {
  try {
    const value = Number(readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processHasMarker(pid: number): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").includes(PROCESS_MARKER);
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).includes(PROCESS_MARKER);
    } catch {
      return false;
    }
  }
}

function readProxyMetadata(file: string): { port: number; upstreamPort: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const port = Reflect.get(parsed, "port");
    const upstreamPort = Reflect.get(parsed, "upstreamPort");
    if (typeof port !== "number" || typeof upstreamPort !== "number") return null;
    return {
      port: validatePort(port, "Google Chat webhook proxy port"),
      upstreamPort: validatePort(upstreamPort, "Google Chat webhook upstream port"),
    };
  } catch {
    return null;
  }
}

function removeProxyState(pidDir: string): void {
  rmSync(join(pidDir, PID_FILE), { force: true });
  rmSync(join(pidDir, STATE_FILE), { force: true });
}

function writePidFile(pidDir: string, pid: number): void {
  const file = join(pidDir, PID_FILE);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
}

export function readGooglechatWebhookProxyState(pidDir: string): GooglechatWebhookProxyState {
  const pid = readPositiveInteger(join(pidDir, PID_FILE));
  const metadata = readProxyMetadata(join(pidDir, STATE_FILE));
  if (pid === null || metadata === null || !processIsAlive(pid) || !processHasMarker(pid)) {
    return { running: false, port: null, upstreamPort: null };
  }
  return { running: true, ...metadata };
}

export function stopGooglechatWebhookProxy(pidDir: string): void {
  const pid = readPositiveInteger(join(pidDir, PID_FILE));
  if (pid !== null && processIsAlive(pid) && processHasMarker(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The proxy exited between validation and signaling.
    }
  }
  removeProxyState(pidDir);
}

export async function startGooglechatWebhookProxy(
  pidDir: string,
  upstreamPortInput: number,
): Promise<number> {
  const upstreamPort = validatePort(upstreamPortInput, "Google Chat webhook upstream port");
  ensureStateDir(pidDir);

  const existing = readGooglechatWebhookProxyState(pidDir);
  if (existing.running && existing.upstreamPort === upstreamPort) return existing.port;
  stopGooglechatWebhookProxy(pidDir);

  const logFd = openSync(join(pidDir, LOG_FILE), "w", 0o600);
  fchmodSync(logFd, 0o600);
  const child = spawn(process.execPath, ["-e", PROXY_SCRIPT, PROCESS_MARKER], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: buildSubprocessEnv({
      NEMOCLAW_GOOGLECHAT_PROXY_STATE_FILE: join(pidDir, STATE_FILE),
      NEMOCLAW_GOOGLECHAT_PROXY_UPSTREAM_PORT: String(upstreamPort),
    }),
  });
  closeSync(logFd);
  child.on("error", () => {});

  if (child.pid === undefined) throw new Error("Google Chat webhook proxy failed to start.");
  child.unref();
  writePidFile(pidDir, child.pid);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readGooglechatWebhookProxyState(pidDir);
    if (state.running && state.upstreamPort === upstreamPort) return state.port;
    if (!processIsAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // Already exited.
  }
  removeProxyState(pidDir);
  throw new Error("Google Chat webhook proxy did not become ready.");
}
