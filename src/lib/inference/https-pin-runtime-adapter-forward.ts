// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";

import { compactText } from "../core/url-utils";
import type { HttpsPinCredentialHeader } from "./https-pin-runtime";

export const HTTPS_PIN_RUNTIME_ADAPTER_MAX_BODY_BYTES = 2 * 1024 * 1024;
const HTTPS_PIN_RUNTIME_ADAPTER_BODY_TIMEOUT_MS = 30_000;
const HTTPS_PIN_RUNTIME_ADAPTER_UPSTREAM_TIMEOUT_MS = 30_000;

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
  "authorization",
  "x-api-key",
]);

export class ForwardHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * The pinned outbound peer for one forwarded request: the validated public
 * address to connect to, and the real hostname to present as TLS SNI / send
 * as the Host header, so certificate validation still targets the real host
 * while the TCP connection goes to the address the SSRF preflight validated.
 */
export interface HttpsPinTarget {
  targetUrl: URL;
  pinnedAddress: string;
  credential: HttpsPinCredentialHeader;
}

export function buildForwardRequestHeaders(
  req: http.IncomingMessage,
  credential: HttpsPinCredentialHeader,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers[credential.name] = credential.value;
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

function readBoundedRequestBody(
  req: http.IncomingMessage,
  bodyTimeoutMs = HTTPS_PIN_RUNTIME_ADAPTER_BODY_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > HTTPS_PIN_RUNTIME_ADAPTER_MAX_BODY_BYTES
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
      // Destroying `req` here (rather than leaving that to the caller) would
      // tear down the same underlying socket `res` needs to flush the 408
      // response on -- the client would see a dead connection instead of the
      // documented JSON body. The caller destroys `req` itself, after the
      // error response finishes writing.
      req.removeAllListeners("data");
      reject(new ForwardHttpError(408, "Request body timed out.", "request_timeout"));
    }, bodyTimeoutMs);

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > HTTPS_PIN_RUNTIME_ADAPTER_MAX_BODY_BYTES) {
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

export function sendForwardError(
  res: http.ServerResponse,
  err: unknown,
  req?: http.IncomingMessage,
): number {
  const status = err instanceof ForwardHttpError ? err.status : 502;
  const code = err instanceof ForwardHttpError ? err.code : "https_pin_runtime_error";
  const message = err instanceof ForwardHttpError ? err.message : "Upstream request failed.";
  // Only the body-read timeout leaves the client still writing indefinitely
  // -- every other rejection (e.g. an oversized body) responds without
  // needing the rest of the client's upload, and destroying the shared
  // socket there would cut off a still-in-flight client write (EPIPE)
  // instead of letting it drain normally.
  const shouldDestroyRequest = Boolean(req) && code === "request_timeout";
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: compactText(message), type: code, code },
      }),
      // Only destroy the request socket once the error response has finished
      // writing, not before -- `req` and `res` share the same underlying
      // socket, so destroying `req` any earlier would take the response down
      // with it.
      () => {
        if (shouldDestroyRequest && !req?.destroyed) req?.destroy();
      },
    );
  } else {
    res.destroy(err instanceof Error ? err : undefined);
  }
  return status;
}

/**
 * Forward one request to a pinned HTTPS peer: connects to `pinnedAddress`
 * (the address the SSRF preflight already validated) while sending TLS SNI
 * and the Host header for the real target hostname, so certificate
 * validation still targets the real host — the Node equivalent of curl
 * `--resolve` with strict hostname verification preserved. HTTP targets
 * connect directly (no pinning needed; the address itself was already
 * validated and substituted upstream of this adapter).
 *
 * Fails closed on any 3xx upstream response: a redirect is never followed or
 * relayed, since a `Location` header is attacker-influenced content that
 * could point at an internal address, silently defeating the pin.
 */
export async function forwardHttpsPinnedRequest(options: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  forwardPath: string;
  target: HttpsPinTarget;
  upstreamTimeoutMs?: number;
  bodyTimeoutMs?: number;
}): Promise<number> {
  const { req, res, forwardPath, target } = options;
  let body: Buffer;
  try {
    body = await readBoundedRequestBody(req, options.bodyTimeoutMs);
  } catch (err) {
    return sendForwardError(res, err, req);
  }

  const isHttps = target.targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = target.targetUrl.port ? Number(target.targetUrl.port) : isHttps ? 443 : 80;

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (status: number) => {
      if (settled) return;
      settled = true;
      res.off("close", onClientClose);
      resolve(status);
    };
    const failRequest = (err: unknown) => {
      // Once the client-facing response is already finalized (normally, or
      // via onClientClose below), res is no longer safe to write to.
      if (settled) return;
      resolveOnce(sendForwardError(res, err));
    };

    const headers = buildForwardRequestHeaders(req, target.credential);
    // `.host` (not `.hostname`) so a non-default port on the real endpoint is
    // preserved in the Host header; TLS SNI below correctly stays bare
    // hostname-only since SNI has no port component.
    headers.host = target.targetUrl.host;
    headers["content-length"] = String(body.length);

    const upstreamReq = transport.request(
      {
        hostname: target.pinnedAddress,
        port,
        path: forwardPath,
        method: req.method,
        headers,
        ...(isHttps ? { servername: target.targetUrl.hostname } : {}),
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        if (status >= 300 && status < 400) {
          upstreamRes.resume();
          failRequest(
            new ForwardHttpError(
              502,
              "Upstream redirect blocked: the pinned adapter does not follow or relay redirects.",
              "redirect_blocked",
            ),
          );
          return;
        }
        res.writeHead(status, buildForwardResponseHeaders(upstreamRes.headers));
        upstreamRes.once("aborted", () => {
          failRequest(
            new ForwardHttpError(502, "Upstream response aborted.", "upstream_response_aborted"),
          );
        });
        upstreamRes.once("error", failRequest);
        upstreamRes.pipe(res);
        upstreamRes.once("end", () => resolveOnce(status));
      },
    );
    // If the original client disconnects before the response finishes, the
    // pinned outbound connection would otherwise keep streaming from the real
    // upstream until it finishes on its own or the upstream timeout fires --
    // an abandoned client could hold a pinned connection open indefinitely.
    const onClientClose = () => {
      if (res.writableEnded) return;
      upstreamReq.destroy();
      resolveOnce(0);
    };
    res.once("close", onClientClose);
    upstreamReq.setTimeout(
      options.upstreamTimeoutMs ?? HTTPS_PIN_RUNTIME_ADAPTER_UPSTREAM_TIMEOUT_MS,
      () => {
        upstreamReq.destroy(
          new ForwardHttpError(504, "Upstream request timed out.", "upstream_timeout"),
        );
      },
    );
    upstreamReq.on("error", (err) => {
      failRequest(err);
    });
    upstreamReq.end(body);
  });
}
