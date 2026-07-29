// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export const VOICE_ACCESS_MAX_REQUEST_BYTES = 1024 * 1024;
export const VOICE_ACCESS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 500;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_TOKEN_BYTES = 4096;
const MAX_HEADER_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const CONVERSATION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent"]);
const FORWARDED_RESPONSE_HEADERS = new Set(["content-language", "content-type", "vary"]);

class VoiceAccessHttpError extends Error {
  constructor(readonly status: number) {
    super(`Voice access request failed with status ${status}`);
  }
}

function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Voice access upstream host must be a loopback IP literal.");
  }
}

function assertAuthToken(token: string): void {
  if (
    Buffer.byteLength(token) < 32 ||
    Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw new Error("Voice access bearer token is malformed.");
  }
}

function assertPrivateTokenFile(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile()) {
    throw new Error(`Voice access token path is not a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Voice access token file must not be accessible by group or others: ${filePath}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Voice access token file is not owned by the current user: ${filePath}`);
  }
  if (stat.size < 1 || stat.size > MAX_TOKEN_BYTES + 1) {
    throw new Error(`Voice access token file has an invalid size: ${filePath}`);
  }
}

/** Read one deployment bearer token without following the final path component. */
export function readVoiceAccessTokenFile(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Voice access token file path must be absolute.");
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform.");
  }

  let descriptor: number | undefined;
  try {
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`Refusing to read a symbolic-link voice access token file: ${filePath}`);
      }
      throw error;
    }
    assertPrivateTokenFile(fs.fstatSync(descriptor), filePath);
    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 2);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TOKEN_BYTES + 1) {
      throw new Error(`Voice access token file has an invalid size: ${filePath}`);
    }
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const token = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
    assertAuthToken(token);
    return token;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseBearerToken(header: string | string[] | undefined): string {
  if (typeof header !== "string") return "";
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? "";
}

function hasExpectedAuthorization(
  actual: string | string[] | undefined,
  expectedTokenHash: Buffer,
): boolean {
  const actualHash = crypto.createHash("sha256").update(parseBearerToken(actual)).digest();
  return crypto.timingSafeEqual(actualHash, expectedTokenHash);
}

function sendEmpty(response: http.ServerResponse, status: number): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(status >= 400 ? { connection: "close" } : {}),
    "content-length": "0",
  });
  response.end();
}

function isAllowedOfferQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return true;
  if (keys.length !== 1 || keys[0] !== "conversation_id") return false;
  const values = url.searchParams.getAll("conversation_id");
  const value = values[0] ?? "";
  return (
    values.length === 1 &&
    CONVERSATION_ID_PATTERN.test(value) &&
    url.search === `?conversation_id=${value}`
  );
}

function isAllowedSignalingRequest(method: string | undefined, url: URL): boolean {
  if (method === "GET" && url.pathname === "/api/ice-servers") {
    return url.search === "";
  }
  if (method === "POST" && url.pathname === "/api/offer") {
    return isAllowedOfferQuery(url);
  }
  return method === "PATCH" && url.pathname === "/api/offer" && url.search === "";
}

function connectionHeaderNames(value: string | string[] | undefined): Set<string> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(
    values
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function buildUpstreamHeaders(
  request: http.IncomingMessage,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const dynamicHopByHopHeaders = connectionHeaderNames(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      dynamicHopByHopHeaders.has(normalized) ||
      !FORWARDED_REQUEST_HEADERS.has(normalized)
    ) {
      continue;
    }
    headers[normalized] = value;
  }
  headers["content-length"] = String(bodyLength);
  return headers;
}

function buildDownstreamHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  bodyLength: number,
  noStore: boolean,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    "content-length": String(bodyLength),
  };
  const dynamicHopByHopHeaders = connectionHeaderNames(upstreamHeaders.connection);
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      dynamicHopByHopHeaders.has(normalized) ||
      !FORWARDED_RESPONSE_HEADERS.has(normalized)
    ) {
      continue;
    }
    headers[normalized] = value;
  }
  if (noStore) headers["cache-control"] = "no-store";
  return headers;
}

function readBoundedBody(
  request: http.IncomingMessage,
  timeoutMs = DEFAULT_BODY_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const rawLength = request.headers["content-length"];
    const contentLength = typeof rawLength === "string" ? Number(rawLength) : 0;
    if (
      typeof rawLength === "string" &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0)
    ) {
      reject(new VoiceAccessHttpError(400));
      return;
    }
    if (contentLength > VOICE_ACCESS_MAX_REQUEST_BYTES) {
      reject(new VoiceAccessHttpError(413));
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new VoiceAccessHttpError(408)), timeoutMs);
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > VOICE_ACCESS_MAX_REQUEST_BYTES) {
        finish(new VoiceAccessHttpError(413));
        return;
      }
      chunks.push(buffer);
    });
    request.once("aborted", () => finish(new VoiceAccessHttpError(400)));
    request.once("error", () => finish(new VoiceAccessHttpError(400)));
    request.once("end", () => finish());
  });
}

function collectBoundedResponse(upstream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    upstream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > VOICE_ACCESS_MAX_RESPONSE_BYTES) {
        upstream.destroy();
        finish(new Error("Voice access upstream response exceeded the limit."));
        return;
      }
      chunks.push(buffer);
    });
    upstream.once("aborted", () => finish(new Error("Voice access upstream response aborted.")));
    upstream.once("error", (error) => finish(error));
    upstream.once("end", () => finish());
  });
}

function forwardSignalingRequest(options: {
  body: Buffer;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  upstreamHost: string;
  upstreamPort: number;
  upstreamTimeoutMs: number;
  url: URL;
}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let upstreamResponse: http.IncomingMessage | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      sendEmpty(options.response, 502);
      finish();
    };
    const upstreamRequest = http.request(
      {
        headers: buildUpstreamHeaders(options.request, options.body.length),
        host: options.upstreamHost,
        method: options.request.method,
        path: `${options.url.pathname}${options.url.search}`,
        port: options.upstreamPort,
      },
      async (incoming) => {
        if (settled) {
          incoming.destroy();
          return;
        }
        upstreamResponse = incoming;
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          incoming.destroy();
          sendEmpty(options.response, status >= 400 && status < 500 ? status : 502);
          finish();
          return;
        }
        try {
          const body = await collectBoundedResponse(incoming);
          if (settled || options.response.destroyed) return;
          options.response.writeHead(
            status,
            buildDownstreamHeaders(
              incoming.headers,
              body.length,
              options.url.pathname === "/api/ice-servers",
            ),
          );
          options.response.end(body);
          finish();
        } catch {
          fail();
        }
      },
    );
    const deadline = setTimeout(() => {
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      fail();
    }, options.upstreamTimeoutMs);
    upstreamRequest.once("error", fail);
    options.response.once("close", () => {
      if (options.response.writableFinished) return;
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      finish();
    });
    upstreamRequest.end(options.body);
  });
}

function probeUpstream(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

interface VoiceAccessRequestHandlerOptions {
  expectedTokenHash: Buffer;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  upstreamHost: string;
  upstreamPort: number;
  upstreamTimeoutMs: number;
}

async function handleVoiceAccessRequest(options: VoiceAccessRequestHandlerOptions): Promise<void> {
  const { request, response } = options;
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
    sendEmpty(response, 404);
    return;
  }

  let url: URL;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    sendEmpty(response, 400);
    return;
  }
  if (request.url.split("?", 1)[0] !== url.pathname) {
    sendEmpty(response, 404);
    return;
  }
  if (!hasExpectedAuthorization(request.headers.authorization, options.expectedTokenHash)) {
    sendEmpty(response, 401);
    return;
  }
  if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") {
    const healthy = await probeUpstream(
      options.upstreamHost,
      options.upstreamPort,
      DEFAULT_HEALTH_TIMEOUT_MS,
    );
    sendEmpty(response, healthy ? 204 : 503);
    return;
  }
  if (!isAllowedSignalingRequest(request.method, url)) {
    sendEmpty(response, 404);
    return;
  }

  try {
    const body = await readBoundedBody(request);
    if (request.method === "GET" && body.length !== 0) {
      sendEmpty(response, 400);
      return;
    }
    await forwardSignalingRequest({
      body,
      request,
      response,
      upstreamHost: options.upstreamHost,
      upstreamPort: options.upstreamPort,
      upstreamTimeoutMs: options.upstreamTimeoutMs,
      url,
    });
  } catch (error) {
    sendEmpty(response, error instanceof VoiceAccessHttpError ? error.status : 502);
  }
}

export interface VoiceAccessGatewayServerOptions {
  authToken: string;
  upstreamHost?: string;
  upstreamPort: number;
  upstreamTimeoutMs?: number;
}

/**
 * Create a loopback-only signaling proxy.
 *
 * The caller owns the listener address and process lifetime. The server never
 * selects an upstream from request data.
 */
export function createVoiceAccessGatewayServer(
  options: VoiceAccessGatewayServerOptions,
): http.Server {
  assertAuthToken(options.authToken);
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const upstreamPort = options.upstreamPort;
  assertLoopbackHost(upstreamHost);
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65_535) {
    throw new Error("Voice access upstream port must be an integer between 1024 and 65535.");
  }
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
    throw new Error("Voice access upstream timeout must be a positive integer.");
  }
  const expectedTokenHash = crypto.createHash("sha256").update(options.authToken).digest();

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void handleVoiceAccessRequest({
      expectedTokenHash,
      request,
      response,
      upstreamHost,
      upstreamPort,
      upstreamTimeoutMs,
    }).catch(() => {
      sendEmpty(response, 502);
    });
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
