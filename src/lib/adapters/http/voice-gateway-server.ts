// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import {
  VOICE_GATEWAY_MAX_REQUEST_BYTES,
  VoiceGatewayRequestError,
  type VoiceResponseEvent,
} from "../../voice-gateway/contracts";
import type { VoiceSessionService } from "../../voice-gateway/session-service";

const MAX_HEADER_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const SESSION_ROUTE = "/v1/voice/sessions";
const TURN_ROUTE_PATTERN = /^\/v1\/voice\/sessions\/([^/]+)\/turns$/u;
const CLOSE_ROUTE_PATTERN = /^\/v1\/voice\/sessions\/([^/]+)$/u;

class BodyError extends Error {
  constructor(readonly status: number) {
    super("invalid_request");
  }
}

function parseBearer(header: string | string[] | undefined): string {
  if (typeof header !== "string") return "";
  return /^Bearer ([\x21-\x7e]+)$/u.exec(header)?.[1] ?? "";
}

function bearerMatches(header: string | string[] | undefined, expectedHash: Buffer): boolean {
  const actualHash = createHash("sha256").update(parseBearer(header)).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function writeJson(response: http.ServerResponse, status: number, value: object): void {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json",
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  response.end(body);
}

function writeEmpty(response: http.ServerResponse, status: number): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  response.end();
}

function errorStatus(code: VoiceGatewayRequestError["code"]): number {
  if (code === "authentication_failed") return 401;
  if (code === "session_not_found" || code === "session_expired") return 404;
  if (
    code === "duplicate_turn" ||
    code === "session_in_progress" ||
    code === "turn_in_progress" ||
    code === "turn_limit_reached"
  ) {
    return 409;
  }
  return 400;
}

function sendRequestError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof VoiceGatewayRequestError) {
    writeJson(response, errorStatus(error.code), { error: error.code });
    return;
  }
  if (error instanceof BodyError) {
    writeJson(response, error.status, { error: "invalid_request" });
    return;
  }
  writeJson(response, 500, { error: "internal_error" });
}

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (request.headers["content-type"] !== "application/json") {
      reject(new BodyError(415));
      return;
    }
    const rawLength = request.headers["content-length"];
    if (Array.isArray(rawLength)) {
      reject(new BodyError(400));
      return;
    }
    const declaredLength = rawLength === undefined ? null : Number(rawLength);
    if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      reject(new BodyError(400));
      return;
    }
    if (declaredLength !== null && declaredLength > VOICE_GATEWAY_MAX_REQUEST_BYTES) {
      reject(new BodyError(413));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new BodyError(400));
        } else {
          resolve(parsed as Record<string, unknown>);
        }
      } catch {
        reject(new BodyError(400));
      }
    };
    const timer = setTimeout(() => finish(new BodyError(408)), BODY_TIMEOUT_MS);
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > VOICE_GATEWAY_MAX_REQUEST_BYTES) {
        finish(new BodyError(413));
        return;
      }
      chunks.push(value);
    });
    request.once("close", () => {
      if (!request.readableEnded) finish(new BodyError(400));
    });
    request.once("error", () => finish(new BodyError(400)));
    request.once("end", () => finish());
  });
}

function exactBody(
  body: Record<string, unknown>,
  fields: readonly string[],
): body is Record<string, string> {
  const keys = Object.keys(body).sort();
  return (
    keys.length === fields.length &&
    keys.every((key, index) => key === [...fields].sort()[index]) &&
    fields.every((field) => typeof body[field] === "string")
  );
}

function decodeRouteValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function handleCreateSession(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  service: VoiceSessionService,
  deploymentCredentialHash: Buffer,
): Promise<void> {
  if (!bearerMatches(request.headers.authorization, deploymentCredentialHash)) {
    writeJson(response, 401, { error: "authentication_failed" });
    return;
  }
  const body = await readJsonBody(request);
  if (!exactBody(body, ["runtimeConversationId"])) {
    throw new VoiceGatewayRequestError("invalid_request");
  }
  writeJson(response, 201, service.createSession(body.runtimeConversationId));
}

async function handleTurn(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  service: VoiceSessionService,
  voiceSessionId: string,
): Promise<void> {
  const grant = parseBearer(request.headers.authorization);
  service.authorizeSession(voiceSessionId, grant);
  const body = await readJsonBody(request);
  if (!exactBody(body, ["commitId", "text"])) {
    throw new VoiceGatewayRequestError("invalid_request");
  }
  let deliveryOpen = true;
  let streamStarted = false;
  response.once("close", () => {
    deliveryOpen = false;
  });
  const deliver = (event: VoiceResponseEvent) => {
    if (!deliveryOpen) return;
    if (!streamStarted) {
      streamStarted = true;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson",
        "x-content-type-options": "nosniff",
      });
    }
    response.write(`${JSON.stringify(event)}\n`);
  };
  await service.commitTurn({
    voiceSessionId,
    grant,
    commitId: body.commitId,
    text: body.text,
    deliver,
    deliveryOpen: () => deliveryOpen,
  });
  if (deliveryOpen) {
    if (streamStarted) response.end();
    else writeJson(response, 502, { error: "agent_gateway_unavailable" });
  }
}

async function handleRequest(options: {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly service: VoiceSessionService;
  readonly deploymentCredentialHash: Buffer;
}): Promise<void> {
  const { request, response } = options;
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
    writeEmpty(response, 404);
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    writeEmpty(response, 400);
    return;
  }
  if (url.search !== "" || request.url !== url.pathname) {
    writeEmpty(response, 404);
    return;
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    if (!bearerMatches(request.headers.authorization, options.deploymentCredentialHash)) {
      writeEmpty(response, 401);
      return;
    }
    writeEmpty(response, 204);
    return;
  }
  if (request.method === "POST" && url.pathname === SESSION_ROUTE) {
    await handleCreateSession(request, response, options.service, options.deploymentCredentialHash);
    return;
  }
  const turn = request.method === "POST" ? TURN_ROUTE_PATTERN.exec(url.pathname) : null;
  if (turn) {
    const voiceSessionId = decodeRouteValue(turn[1]);
    if (voiceSessionId === null) {
      writeEmpty(response, 400);
      return;
    }
    await handleTurn(request, response, options.service, voiceSessionId);
    return;
  }
  const close = request.method === "DELETE" ? CLOSE_ROUTE_PATTERN.exec(url.pathname) : null;
  if (close) {
    const voiceSessionId = decodeRouteValue(close[1]);
    if (voiceSessionId === null) {
      writeEmpty(response, 400);
      return;
    }
    options.service.closeSession(voiceSessionId, parseBearer(request.headers.authorization));
    writeEmpty(response, 204);
    return;
  }
  writeEmpty(response, 404);
}

export function createVoiceGatewayServer(options: {
  readonly deploymentCredential: string;
  readonly service: VoiceSessionService;
}): http.Server {
  const deploymentCredentialHash = createHash("sha256")
    .update(options.deploymentCredential)
    .digest();
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void handleRequest({
      request,
      response,
      service: options.service,
      deploymentCredentialHash,
    }).catch((error) => sendRequestError(response, error));
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}
