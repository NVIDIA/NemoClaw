// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as http from "http";
import type { IncomingMessage, ServerResponse, Server } from "http";
import * as registry from "./registry";
import { getSandboxList } from "./api-metrics";
import {
  stopSandbox,
  startSandbox,
  restartSandbox,
  runSandboxCommand,
  readConfig,
  writeConfig,
} from "./api-commands";

const SSE_TICK_MS = 5_000;
const SSE_SNAPSHOT_TICKS = 6;

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: string[],
) => void | Promise<void>;

type Route = [string, RegExp, RouteHandler];

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function handleSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  let tick = 0;
  let previousData: string | null = null;

  function sendTick() {
    const data = getSandboxList();
    const serialized = JSON.stringify(data);
    const isSnapshot = tick % SSE_SNAPSHOT_TICKS === 0;
    const changed = serialized !== previousData;

    if (isSnapshot || changed) {
      const eventType = isSnapshot ? "sandbox.snapshot" : "sandbox.metrics";
      res.write(`event: ${eventType}\ndata: ${serialized}\n\n`);
      previousData = serialized;
    }

    tick++;
  }

  sendTick();
  const timer = setInterval(sendTick, SSE_TICK_MS);

  res.on("close", () => clearInterval(timer));
}

async function sandboxDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  [name]: string[],
): Promise<void> {
  const sandbox = registry.getSandbox(name);
  if (!sandbox) return json(res, 404, { error: `sandbox '${name}' not found` });
  const { sandboxes } = getSandboxList();
  return json(res, 200, sandboxes.find((s) => s.name === name) ?? sandbox);
}

async function sandboxCommand(
  req: IncomingMessage,
  res: ServerResponse,
  [name]: string[],
): Promise<void> {
  const body = await readBody(req);
  if (!body.command || typeof body.command !== "string") {
    return json(res, 400, { error: "'command' field is required and must be a string" });
  }
  return json(res, 200, runSandboxCommand(name, body.command));
}

async function configPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  writeConfig(body);
  return json(res, 200, readConfig());
}

// Route table: [method, regex, handler]. Handler receives (req, res, regexCaptureGroups).
const ROUTES: Route[] = [
  ["GET", /^\/events\/?$/, (_req, res) => handleSSE(res)],
  ["GET", /^\/sandboxes\/?$/, (_req, res) => json(res, 200, getSandboxList())],
  ["GET", /^\/sandboxes\/([^/]+)\/?$/, sandboxDetail],
  ["POST", /^\/sandboxes\/([^/]+)\/start\/?$/, (_req, res) => json(res, 200, startSandbox())],
  ["POST", /^\/sandboxes\/([^/]+)\/stop\/?$/, (_req, res, [n]) => json(res, 200, stopSandbox(n))],
  [
    "POST",
    /^\/sandboxes\/([^/]+)\/restart\/?$/,
    (_req, res, [n]) => json(res, 200, restartSandbox(n)),
  ],
  ["POST", /^\/sandboxes\/([^/]+)\/commands\/?$/, sandboxCommand],
  ["GET", /^\/config\/?$/, (_req, res) => json(res, 200, readConfig())],
  ["PUT", /^\/config\/?$/, configPut],
];

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req;
  const pathname = (url || "/").split("?")[0];

  try {
    for (const [m, pattern, handler] of ROUTES) {
      if (m !== method) continue;
      const match = pattern.exec(pathname);
      if (match) return await handler(req, res, match.slice(1));
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: (err as Error).message });
  }
}

export function createApiServer(): Server {
  return http.createServer(handleRequest);
}

export interface RunApiCommandDeps {
  port: number;
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  onExit?: (code: number) => void;
}

export function runApiCommand(deps: RunApiCommandDeps): Server {
  const log = deps.log ?? console.log;
  const onExit = deps.onExit ?? ((code: number) => process.exit(code));
  const server = createApiServer();
  server.listen(deps.port, "127.0.0.1", () => {
    const addr = server.address();
    const listeningPort = typeof addr === "object" && addr ? addr.port : deps.port;
    log(`nemoclaw api running at http://127.0.0.1:${listeningPort}`);
    log("Press Ctrl+C to stop.");
  });
  process.on("SIGINT", () => {
    server.close(() => onExit(0));
  });
  return server;
}
