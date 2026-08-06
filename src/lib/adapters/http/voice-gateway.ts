// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import {
  type VoiceResponseEvent,
  VoiceSessionError,
  type VoiceSessionService,
} from "../../domain/voice/session-service";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_SESSION_BODY_BYTES = 1024;
const MAX_TURN_BODY_BYTES = 20 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_STREAM_BUFFER_BYTES = 64 * 1024;

class VoiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function hashCredential(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function parseBearer(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "";
  return /^Bearer ([^\s]+)$/u.exec(value)?.[1] ?? "";
}

function bearerMatches(header: string | string[] | undefined, expectedHash: Buffer): boolean {
  return crypto.timingSafeEqual(hashCredential(parseBearer(header)), expectedHash);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(body.length),
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  response.end(body);
}

function sendEmpty(response: http.ServerResponse, status: number): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  response.end();
}

function sendError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof VoiceHttpError || error instanceof VoiceSessionError) {
    sendJson(response, error.status, { error: error.code });
    return;
  }
  sendJson(response, 500, { error: "internal_error" });
}

function readJsonBody(
  request: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      reject(new VoiceHttpError(415, "unsupported_media_type"));
      return;
    }
    const rawLength = request.headers["content-length"];
    if (Array.isArray(rawLength)) {
      reject(new VoiceHttpError(400, "invalid_request"));
      return;
    }
    const contentLength = rawLength === undefined ? undefined : Number(rawLength);
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0)
    ) {
      reject(new VoiceHttpError(400, "invalid_request"));
      return;
    }
    if (contentLength !== undefined && contentLength > maxBytes) {
      reject(new VoiceHttpError(413, "request_too_large"));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new VoiceHttpError(400, "invalid_request"));
      }
    };
    const timer = setTimeout(
      () => finish(new VoiceHttpError(408, "request_timeout")),
      BODY_TIMEOUT_MS,
    );
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxBytes) finish(new VoiceHttpError(413, "request_too_large"));
      else chunks.push(value);
    });
    request.once("error", () => finish(new VoiceHttpError(400, "invalid_request")));
    request.once("end", () => finish());
    request.once("close", () => {
      if (!request.readableEnded) finish(new VoiceHttpError(400, "invalid_request"));
    });
  });
}

function pathParts(requestUrl: string | undefined): string[] | undefined {
  if (!requestUrl?.startsWith("/") || requestUrl.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }
  if (url.search || url.hash || requestUrl !== url.pathname) return undefined;
  return url.pathname.split("/").filter(Boolean);
}

export interface VoiceGatewayServerOptions {
  admissionCredential: string;
  sessionService: VoiceSessionService;
}

export function createVoiceGatewayServer(options: VoiceGatewayServerOptions): http.Server {
  const admissionHash = hashCredential(options.admissionCredential);
  const server = http.createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    async (request, response) => {
      try {
        const parts = pathParts(request.url);
        if (!parts) throw new VoiceHttpError(404, "not_found");
        if (request.method === "GET" && parts.length === 1 && parts[0] === "healthz") {
          sendEmpty(response, 204);
          return;
        }
        if (request.method === "POST" && parts.join("/") === "v1/voice-sessions") {
          if (!bearerMatches(request.headers.authorization, admissionHash)) {
            throw new VoiceHttpError(401, "unauthorized");
          }
          const body = await readJsonBody(request, MAX_SESSION_BODY_BYTES);
          const allowed = new Set(["runtimeConversationId"]);
          if (Object.keys(body).some((key) => !allowed.has(key))) {
            throw new VoiceHttpError(400, "invalid_request");
          }
          const created = options.sessionService.createSession(body.runtimeConversationId);
          sendJson(response, 201, {
            voiceSessionId: created.voiceSessionId,
            grant: created.grant,
            expiresAt: created.expiresAt,
          });
          return;
        }
        if (parts[0] !== "v1" || parts[1] !== "voice-sessions") {
          throw new VoiceHttpError(404, "not_found");
        }
        const voiceSessionId = parts[2] ?? "";
        const grant = parseBearer(request.headers.authorization);
        if (request.method === "DELETE" && parts.length === 3) {
          options.sessionService.closeSession(voiceSessionId, grant);
          sendEmpty(response, 204);
          return;
        }
        if (request.method !== "POST" || parts.length !== 4 || parts[3] !== "turns") {
          throw new VoiceHttpError(404, "not_found");
        }
        const body = await readJsonBody(request, MAX_TURN_BODY_BYTES);
        const allowed = new Set(["commitId", "text"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new VoiceHttpError(400, "invalid_request");
        }
        let deliveryOpen = true;
        let streamStarted = false;
        response.once("close", () => {
          deliveryOpen = false;
          if (streamStarted && !response.writableFinished) {
            options.sessionService.disconnectTurn(voiceSessionId, grant);
          }
        });
        const deliver = (event: VoiceResponseEvent): boolean => {
          if (!deliveryOpen || response.destroyed || response.writableEnded) return false;
          if (!streamStarted) {
            streamStarted = true;
            response.writeHead(200, {
              "cache-control": "no-store",
              "content-type": "application/x-ndjson",
              "x-content-type-options": "nosniff",
            });
          }
          response.write(`${JSON.stringify(event)}\n`);
          if (response.writableLength > MAX_STREAM_BUFFER_BYTES) {
            deliveryOpen = false;
            options.sessionService.disconnectTurn(voiceSessionId, grant);
            response.destroy();
            return false;
          }
          return true;
        };
        await options.sessionService.startTurn(
          voiceSessionId,
          grant,
          body.commitId,
          body.text,
          deliver,
        );
        if (!response.destroyed) response.end();
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendError(response, error);
      }
    },
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  return server;
}
