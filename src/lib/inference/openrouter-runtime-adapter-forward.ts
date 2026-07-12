// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";

import { compactText } from "../core/url-utils";
import { OPENROUTER_DEFAULT_HEADERS } from "./openrouter";
import { sendJson } from "./openrouter-runtime-adapter-common";

export const OPENROUTER_RUNTIME_ADAPTER_MAX_BODY_BYTES = 2 * 1024 * 1024;
const OPENROUTER_RUNTIME_ADAPTER_BODY_TIMEOUT_MS = 30_000;
const OPENROUTER_RUNTIME_ADAPTER_UPSTREAM_TIMEOUT_MS = 30_000;

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

class ForwardHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function getBearerAuthorizationToken(actual: string | string[] | undefined): string | null {
  const header = Array.isArray(actual) ? actual[0] : actual;
  const match = typeof header === "string" ? header.match(/^Bearer\s+(\S+)$/) : null;
  return match?.[1] ?? null;
}

export function buildUpstreamUrl(upstreamBaseUrl: string, reqUrl: string | undefined): URL {
  const incoming = new URL(reqUrl || "/", "http://127.0.0.1");
  const upstream = new URL(upstreamBaseUrl);
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const suffix = incoming.pathname.startsWith("/v1")
    ? incoming.pathname.slice("/v1".length)
    : incoming.pathname;
  upstream.pathname = `${basePath}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  upstream.search = incoming.search;
  return upstream;
}

export function buildForwardRequestHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  for (const [name, value] of OPENROUTER_DEFAULT_HEADERS) {
    headers[name] = value;
  }
  return headers;
}

function buildForwardResponseHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function readBoundedRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > OPENROUTER_RUNTIME_ADAPTER_MAX_BODY_BYTES
    ) {
      reject(new ForwardHttpError(413, "Request body is too large.", "request_too_large"));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ForwardHttpError(408, "Request body timed out.", "request_timeout"));
      req.destroy();
    }, OPENROUTER_RUNTIME_ADAPTER_BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > OPENROUTER_RUNTIME_ADAPTER_MAX_BODY_BYTES) {
        settled = true;
        clearTimeout(timer);
        reject(new ForwardHttpError(413, "Request body is too large.", "request_too_large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendForwardError(res: http.ServerResponse, err: unknown): number {
  const status = err instanceof ForwardHttpError ? err.status : 502;
  const code = err instanceof ForwardHttpError ? err.code : "openrouter_runtime_error";
  const message = err instanceof ForwardHttpError ? err.message : "OpenRouter request failed.";
  if (!res.headersSent) {
    sendJson(res, status, {
      error: {
        message: compactText(message),
        type: code,
        code,
      },
    });
  } else {
    res.destroy(err instanceof Error ? err : undefined);
  }
  return status;
}

export async function forwardOpenRouterRequest(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  upstreamBaseUrl: string;
  upstreamTimeoutMs?: number;
}): Promise<number> {
  const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, options.req.url);
  const transport = upstreamUrl.protocol === "http:" ? http : https;
  let body: Buffer;
  try {
    body = await readBoundedRequestBody(options.req);
  } catch (err) {
    return sendForwardError(options.res, err);
  }
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const failRequest = (err: unknown) => {
      resolveOnce(sendForwardError(options.res, err));
    };
    const headers = buildForwardRequestHeaders(options.req);
    headers["content-length"] = String(body.length);
    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: options.req.method,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        options.res.writeHead(status, buildForwardResponseHeaders(upstreamRes.headers));
        upstreamRes.once("aborted", () => {
          failRequest(
            new ForwardHttpError(
              502,
              "OpenRouter upstream response aborted.",
              "upstream_response_aborted",
            ),
          );
        });
        upstreamRes.once("error", failRequest);
        upstreamRes.pipe(options.res);
        upstreamRes.once("end", () => resolveOnce(status));
      },
    );
    upstreamReq.setTimeout(
      options.upstreamTimeoutMs ?? OPENROUTER_RUNTIME_ADAPTER_UPSTREAM_TIMEOUT_MS,
      () => {
        upstreamReq.destroy(
          new ForwardHttpError(504, "OpenRouter upstream request timed out.", "upstream_timeout"),
        );
      },
    );
    upstreamReq.on("error", (err) => {
      failRequest(err);
    });
    upstreamReq.end(body);
  });
}
