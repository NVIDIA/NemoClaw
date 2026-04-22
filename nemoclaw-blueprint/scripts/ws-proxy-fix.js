"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const node_net_1 = __importDefault(require("node:net"));
const node_tls_1 = __importDefault(require("node:tls"));
const node_https_1 = __importDefault(require("node:https"));
const node_url_1 = require("node:url");
const _PATCHED = Symbol.for("nemoclaw.wsProxyFix");
/**
 * Self-executing initialiser.  Using an IIFE rather than top-level `return`
 * keeps the source valid TypeScript while preserving early-exit semantics.
 */
(function wsProxyFixInit() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxyUrl)
        return;
    if (globalThis[_PATCHED])
        return;
    let proxy;
    try {
        proxy = new node_url_1.URL(proxyUrl);
    }
    catch {
        return;
    }
    const proxyHost = proxy.hostname;
    const proxyPort = parseInt(proxy.port, 10) || 3128;
    // ---------- CONNECT tunnel agent ----------------------------------------
    /**
     * Create an https.Agent whose createConnection() establishes a CONNECT
     * tunnel through the HTTP proxy, then upgrades to TLS — the correct
     * behaviour that EnvHttpProxyAgent fails to perform for HTTPS.
     */
    function createTunnelAgent(targetHost, targetPort) {
        const agent = new node_https_1.default.Agent({ keepAlive: false, maxSockets: 1 });
        // Override createConnection to route through the proxy's CONNECT tunnel.
        // The typing is intentionally loosened because the actual Node.js runtime
        // signature is broader than what @types/node declares.
        agent.createConnection = function (options, callback) {
            const connectReq = node_http_1.default.request({
                host: proxyHost,
                port: proxyPort,
                method: "CONNECT",
                path: `${targetHost}:${targetPort}`,
                headers: { Host: `${targetHost}:${targetPort}` },
            });
            connectReq.on("connect", (_res, socket, head) => {
                if (_res.statusCode !== 200) {
                    socket.destroy();
                    callback(new Error(`ws-proxy-fix: CONNECT ${targetHost}:${targetPort} via proxy failed (${_res.statusCode})`));
                    return;
                }
                // Preserve any bytes already buffered from the tunnel before TLS.
                if (head && head.length > 0) {
                    socket.unshift(head);
                }
                const tlsSocket = node_tls_1.default.connect({
                    socket,
                    servername: options.servername || targetHost,
                });
                callback(null, tlsSocket);
            });
            connectReq.on("error", (err) => {
                connectReq.destroy();
                callback(err);
            });
            connectReq.end();
            // createConnection expects a synchronous return; the real socket arrives
            // via the callback.  Return a placeholder that Node.js will discard.
            return new node_net_1.default.Socket();
        };
        return agent;
    }
    // ---------- Target check -------------------------------------------------
    /**
     * Return true only for WebSocket upgrade requests targeting Discord
     * gateway hosts (gateway.discord.gg and regional variants).
     */
    function isDiscordWsUpgrade(host, headers) {
        if (!host || !headers || typeof headers !== "object")
            return false;
        const h = host.toLowerCase();
        if (h !== "gateway.discord.gg" && !h.endsWith(".discord.gg"))
            return false;
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "upgrade" &&
                String(headers[key]).toLowerCase() === "websocket") {
                return true;
            }
        }
        return false;
    }
    // ---------- Patch https.request() ---------------------------------------
    // Capture the original — typed as a loose callable so we can invoke it
    // with the normalised (options, cb) form without fighting overload resolution.
    const origRequest = node_https_1.default.request;
    function wsProxyFixedRequest(input, options, callback) {
        // --- Normalise arguments (Node.js accepts multiple call signatures) ---
        let opts;
        let cb;
        if (typeof input === "string" || input instanceof node_url_1.URL) {
            if (typeof options === "function") {
                cb = options;
                opts = {};
            }
            else {
                opts = options || {};
                cb = callback;
            }
            const url = typeof input === "string" ? new node_url_1.URL(input) : input;
            opts = {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                ...opts,
            };
        }
        else {
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
            if (!opts.agent || opts.agent === node_https_1.default.globalAgent) {
                const port = parseInt(String(opts.port), 10) || 443;
                opts = { ...opts, agent: createTunnelAgent(host, port) };
            }
            return origRequest.call(node_https_1.default, opts, cb);
        }
        // Non-WebSocket — pass through original arguments unchanged.
        // eslint-disable-next-line prefer-rest-params
        return origRequest.apply(node_https_1.default, arguments);
    }
    // Replace https.request with our patched version.
    node_https_1.default.request = wsProxyFixedRequest;
    globalThis[_PATCHED] = true;
})();
