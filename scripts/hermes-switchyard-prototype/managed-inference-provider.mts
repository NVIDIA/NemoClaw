#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_ENTRIES = 256;
const bindHost = process.env.NEMOCLAW_MANAGED_PROTOTYPE_BIND_HOST || "0.0.0.0";
const bindPort = Number(process.env.NEMOCLAW_MANAGED_PROTOTYPE_BIND_PORT || "0");
const readyFile = process.env.NEMOCLAW_MANAGED_PROTOTYPE_READY_FILE || "";
const requestLog = process.env.NEMOCLAW_MANAGED_PROTOTYPE_REQUEST_LOG || "";
const apiKey = process.env.NEMOCLAW_MANAGED_PROTOTYPE_API_KEY || "";
const model = "nemoclaw-managed-bootstrap";
let loggedBytes = 0;
let loggedEntries = 0;

if (!readyFile || !requestLog || !apiKey) {
  throw new Error("Managed inference provider requires ready, request-log, and API-key inputs");
}
if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65_535) {
  throw new Error("Managed inference provider received an invalid port");
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url || "/", "http://nemoclaw-managed-prototype.invalid").pathname;
}

function authorizationMatches(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function record(entry: Record<string, unknown>): void {
  if (loggedEntries >= MAX_LOG_ENTRIES) return;
  const line = `${JSON.stringify(entry)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (loggedBytes + lineBytes > MAX_LOG_BYTES) return;
  appendFileSync(requestLog, line, { encoding: "utf8", mode: 0o600 });
  loggedBytes += lineBytes;
  loggedEntries += 1;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error("request body exceeded 1 MiB");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

const server = createServer(async (request, response) => {
  const path = requestPath(request);
  const authMatches = authorizationMatches(request);

  if (request.method === "GET" && ["/v1/models", "/models"].includes(path)) {
    record({
      auth_matches: authMatches,
      method: "GET",
      path,
      source_loopback: request.socket.remoteAddress === "127.0.0.1",
    });
    if (!authMatches) {
      sendJson(response, 401, { error: { message: "missing prototype bearer credential" } });
      return;
    }
    sendJson(response, 200, {
      data: [{ id: model, object: "model" }],
      object: "list",
    });
    return;
  }

  if (request.method === "POST" && ["/v1/chat/completions", "/chat/completions"].includes(path)) {
    if (!authMatches) {
      record({ auth_matches: false, method: "POST", rejected: "unauthorized" });
      sendJson(response, 401, { error: { message: "missing prototype bearer credential" } });
      request.resume();
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readJson(request);
    } catch {
      record({ auth_matches: authMatches, method: "POST", path, rejected: "invalid_body" });
      sendJson(response, 400, { error: { message: "invalid request body" } });
      return;
    }
    record({
      auth_matches: authMatches,
      method: "POST",
      model: typeof payload.model === "string" ? payload.model.slice(0, 256) : null,
      path,
      stream: payload.stream === true,
    });
    sendJson(response, 200, {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: "bootstrap ok", role: "assistant" },
        },
      ],
      created: 0,
      id: "chatcmpl-nemoclaw-managed-prototype",
      model,
      object: "chat.completion",
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
    return;
  }

  record(
    authMatches
      ? {
          auth_matches: true,
          method: request.method,
          path: path.slice(0, 256),
          rejected: "not_found",
        }
      : { auth_matches: false, method: request.method, rejected: "not_found" },
  );
  sendJson(response, 404, { error: { message: "not found" } });
});

server.listen(bindPort, bindHost, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Managed inference provider did not bind to TCP");
  }
  writeFileSync(readyFile, `${address.port}\n`, { encoding: "utf8", mode: 0o600 });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
