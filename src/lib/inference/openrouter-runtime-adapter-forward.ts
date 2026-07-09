// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";

import { compactText } from "../core/url-utils";
import { OPENROUTER_DEFAULT_HEADERS } from "./openrouter";
import { sendJson } from "./openrouter-runtime-adapter-common";

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

export function hasBearerAuthorization(actual: string | string[] | undefined): boolean {
  const header = Array.isArray(actual) ? actual[0] : actual;
  return typeof header === "string" && /^Bearer\s+\S+/.test(header);
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

export function forwardOpenRouterRequest(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  upstreamBaseUrl: string;
}): Promise<number> {
  const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, options.req.url);
  const transport = upstreamUrl.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: options.req.method,
        headers: buildForwardRequestHeaders(options.req),
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        options.res.writeHead(status, buildForwardResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(options.res);
        upstreamRes.on("end", () => resolve(status));
      },
    );
    upstreamReq.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!options.res.headersSent) {
        sendJson(options.res, 502, {
          error: {
            message: compactText(message || "OpenRouter request failed."),
            type: "openrouter_runtime_error",
            code: "openrouter_runtime_error",
          },
        });
      } else {
        options.res.destroy(err instanceof Error ? err : undefined);
      }
      resolve(502);
    });
    options.req.on("error", () => {
      upstreamReq.destroy();
      resolve(499);
    });
    options.req.pipe(upstreamReq);
  });
}
