// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// ws-proxy-fix.ts — preload script to fix Discord WebSocket connections
// through the OpenShell L7 proxy when HTTPS_PROXY is set.
//
// Problem (NemoClaw#1570):
//   The `ws` library (used by OpenClaw's Discord extension via @buape/carbon)
//   establishes WebSocket connections by calling https.request() for wss:// URLs.
//   Inside the sandbox, HTTPS_PROXY is set and Node.js 22 (with
//   NODE_USE_ENV_PROXY=1) routes these through EnvHttpProxyAgent — which sends a
//   forward proxy request (GET https://...) instead of a CONNECT tunnel. The
//   OpenShell L7 proxy correctly rejects forward proxy HTTPS with HTTP 400.
//   Without NODE_USE_ENV_PROXY, ws goes direct, which the sandbox network
//   namespace blocks. Either way, the WebSocket handshake fails and the bot
//   loops on close code 1006.
//
// Fix:
//   Patch https.request() to detect WebSocket upgrade requests to Discord
//   gateway hosts (gateway.discord.gg) and inject an agent that issues a proper
//   CONNECT request to the proxy, then upgrades the tunnel socket to TLS.
//   All other HTTPS requests — including non-Discord WebSockets — pass through
//   completely untouched.
//
//   Uses only Node.js built-in modules — no external dependencies.
//
//   Belt-and-suspenders: works regardless of any upstream OpenClaw changes.
//   If the caller already provides a custom (non-default) agent, we step aside
//   — no double-tunnelling.

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { URL } from "node:url";

const _PATCHED = Symbol.for("nemoclaw.wsProxyFix");

type RequestCallback = (res: http.IncomingMessage) => void;

/**
 * Merged options after normalising the multiple call signatures of
 * https.request().  Only fields we inspect are listed.
 */
interface ReqOpts extends https.RequestOptions {
  headers?: http.OutgoingHttpHeaders;
}

/**
 * Self-executing initialiser.  Using an IIFE rather than top-level `return`
 * keeps the source valid TypeScript while preserving early-exit semantics.
 */
(function wsProxyFixInit(): void {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return;

  if ((globalThis as Record<symbol, unknown>)[_PATCHED]) return;

  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    return;
  }

  const proxyHost: string = proxy.hostname;
  const proxyPort: number = parseInt(proxy.port, 10) || 3128;

  // ---------- CONNECT tunnel agent ----------------------------------------

  /**
   * Create an https.Agent whose createConnection() establishes a CONNECT
   * tunnel through the HTTP proxy, then upgrades to TLS — the correct
   * behaviour that EnvHttpProxyAgent fails to perform for HTTPS.
   */
  function createTunnelAgent(
    targetHost: string,
    targetPort: number,
  ): https.Agent {
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });

    // Override createConnection to route through the proxy's CONNECT tunnel.
    // The typing is intentionally loosened because the actual Node.js runtime
    // signature is broader than what @types/node declares.
    (agent as unknown as Record<string, unknown>).createConnection = function (
      options: Record<string, unknown>,
      callback: (err: Error | null, socket?: tls.TLSSocket) => void,
    ): net.Socket {
      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: { Host: `${targetHost}:${targetPort}` },
      });

      connectReq.on(
        "connect",
        (_res: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
          if (_res.statusCode !== 200) {
            socket.destroy();
            callback(
              new Error(
                `ws-proxy-fix: CONNECT ${targetHost}:${targetPort} via proxy failed (${_res.statusCode})`,
              ),
            );
            return;
          }
          // Preserve any bytes already buffered from the tunnel before TLS.
          if (head && head.length > 0) {
            socket.unshift(head);
          }
          const tlsSocket = tls.connect({
            socket,
            servername: (options.servername as string) || targetHost,
          });
          callback(null, tlsSocket);
        },
      );

      connectReq.on("error", (err: Error) => {
        connectReq.destroy();
        callback(err);
      });
      connectReq.end();

      // createConnection expects a synchronous return; the real socket arrives
      // via the callback.  Return a placeholder that Node.js will discard.
      return new net.Socket();
    };

    return agent;
  }

  // ---------- Target check -------------------------------------------------

  /**
   * Return true only for WebSocket upgrade requests targeting Discord
   * gateway hosts (gateway.discord.gg and regional variants).
   */
  function isDiscordWsUpgrade(
    host: string | undefined,
    headers: http.OutgoingHttpHeaders | undefined,
  ): boolean {
    if (!host || !headers || typeof headers !== "object") return false;
    const h = host.toLowerCase();
    if (h !== "gateway.discord.gg" && !h.endsWith(".discord.gg")) return false;
    for (const key of Object.keys(headers)) {
      if (
        key.toLowerCase() === "upgrade" &&
        String(headers[key]).toLowerCase() === "websocket"
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------- Patch https.request() ---------------------------------------

  // Capture the original — typed as a loose callable so we can invoke it
  // with the normalised (options, cb) form without fighting overload resolution.
  const origRequest = https.request as (
    options: ReqOpts,
    callback?: RequestCallback,
  ) => http.ClientRequest;

  function wsProxyFixedRequest(
    input: string | URL | ReqOpts,
    options?: RequestCallback | ReqOpts,
    callback?: RequestCallback,
  ): http.ClientRequest {
    // --- Normalise arguments (Node.js accepts multiple call signatures) ---
    let opts: ReqOpts;
    let cb: RequestCallback | undefined;

    if (typeof input === "string" || input instanceof URL) {
      if (typeof options === "function") {
        cb = options;
        opts = {};
      } else {
        opts = (options as ReqOpts) || {};
        cb = callback;
      }
      const url = typeof input === "string" ? new URL(input) : input;
      opts = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        ...opts,
      };
    } else {
      opts = input || {};
      cb = typeof options === "function" ? options : callback;
    }

    // opts.host may include a port (e.g. "gateway.discord.gg:443") — strip it
    // so the CONNECT path doesn't become "host:443:443".
    let host = opts.hostname || undefined;
    if (!host && opts.host) {
      host = opts.host.replace(/:\d+$/, "");
    }
    if (isDiscordWsUpgrade(host, opts.headers)) {
      // Discord WebSocket upgrade — inject CONNECT tunnel agent unless the
      // caller already provides a custom (non-default) agent.
      if (!opts.agent || opts.agent === https.globalAgent) {
        const port = parseInt(String(opts.port), 10) || 443;
        opts = { ...opts, agent: createTunnelAgent(host!, port) };
      }
      return origRequest.call(https, opts, cb);
    }

    // Non-WebSocket — pass through original arguments unchanged.
    // eslint-disable-next-line prefer-rest-params
    return (origRequest as unknown as Function).apply(https, arguments);
  }

  // Replace https.request with our patched version.
  (https as unknown as Record<string, unknown>).request = wsProxyFixedRequest;

  (globalThis as Record<symbol, unknown>)[_PATCHED] = true;
})();

export {};
