// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// http-proxy-fix.js — http.request() wrapper resolving the double-proxy
// conflict between NODE_USE_ENV_PROXY=1 (Node.js 22+) and HTTP libraries
// that independently read HTTPS_PROXY (axios, follow-redirects,
// proxy-from-env). See NemoClaw#2109.
//
// Problem:
//   Node.js 22 with NODE_USE_ENV_PROXY=1 (baked into the OpenShell base
//   image) intercepts https.request() calls and handles proxying via a
//   CONNECT tunnel. HTTP libraries also read HTTPS_PROXY and configure
//   HTTP FORWARD mode, so the request is processed twice and the L7 proxy
//   rejects it with "FORWARD rejected: HTTPS requires CONNECT".
//
// Fix:
//   Wrap http.request() — the lowest common denominator every HTTP client
//   bottoms out at. Detect FORWARD-mode requests (hostname = proxy IP,
//   path = full https:// URL) and rewrite them as https.request() against
//   the real target host, letting NODE_USE_ENV_PROXY handle the CONNECT
//   tunnel correctly.
//
// Earlier PR #2110 tried a Module._load hook intercepting require('axios').
// That could not catch follow-redirects + proxy-from-env bundled as ESM in
// OpenClaw's dist/ — there are no require() calls to intercept. The
// http.request wrapper sits below all libraries and catches every path.
//
// This file is the canonical source for review and tests. At sandbox boot
// nemoclaw-start.sh writes an identical copy to /tmp/nemoclaw-http-proxy-fix.js
// and loads it via NODE_OPTIONS=--require. A sync test enforces byte-for-byte
// equality. The content cannot be baked into /opt/nemoclaw-blueprint/scripts/
// because adding files to the optimized sandbox build context cache-busts the
// `COPY nemoclaw-blueprint/` Dockerfile layer and hangs npm ci in k3s
// Docker-in-Docker — see src/lib/sandbox-build-context.ts.

(function () {
  'use strict';
  if (process.env.NODE_USE_ENV_PROXY !== '1') return;

  var http = require('http');
  var origRequest = http.request;

  var proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  var proxyHost = '';
  try {
    proxyHost = new URL(proxyUrl).hostname;
  } catch (_e) {
    /* no usable proxy configured */
  }
  if (!proxyHost) return;

  // Strip headers that were meaningful for the proxy hop only. Once we
  // re-issue against the target via https.request, the original Host
  // points at the proxy and the hop-by-hop headers (RFC 7230 §6.1) leak
  // upstream — they describe the connection between the caller and the
  // proxy, not the rewritten connection to the target.
  //
  // RFC 7230 §6.1 hop-by-hop set (request direction):
  //   Connection, Keep-Alive, Proxy-Authorization, TE, Trailer,
  //   Transfer-Encoding, Upgrade.
  // Also stripped: Host (points at the proxy); Proxy-Connection (de
  // facto deprecated header still emitted by some clients); and
  // Proxy-Authenticate (response-only per RFC 7235 §4.3, included
  // belt-and-suspenders for clients that echo response headers into
  // retry-request options). Plus: per RFC 7230 §6.1, any token named in
  // the Connection header is itself hop-by-hop and must be stripped.
  var STATIC_HOP_BY_HOP = [
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ];

  function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return undefined;
    // Collect tokens named in the Connection header — those become
    // hop-by-hop transitively per RFC 7230 §6.1.
    var dynamic = new Set();
    for (var k in headers) {
      if (
        !Object.prototype.hasOwnProperty.call(headers, k) ||
        String(k).toLowerCase() !== 'connection'
      ) {
        continue;
      }
      var raw = headers[k];
      var listed = Array.isArray(raw) ? raw.join(',') : raw;
      if (typeof listed === 'string') {
        listed.split(',').forEach(function (token) {
          var t = token.trim().toLowerCase();
          if (t) dynamic.add(t);
        });
      }
    }
    var staticSet = new Set(STATIC_HOP_BY_HOP);
    var out = {};
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      var lower = String(key).toLowerCase();
      if (staticSet.has(lower) || dynamic.has(lower)) continue;
      out[key] = headers[key];
    }
    return out;
  }

  http.request = function (options, callback) {
    if (typeof options === 'string' || !options) {
      return origRequest.apply(http, arguments);
    }
    if (
      options.hostname === proxyHost &&
      options.path &&
      options.path.startsWith('https://')
    ) {
      var target;
      try {
        target = new URL(options.path);
      } catch (_e) {
        return origRequest.apply(http, arguments);
      }
      var https = require('https');
      // Clone caller's options and overwrite proxy-specific routing
      // fields. Strip fields that were set up for the proxy hop and
      // would misbehave on the rewritten https.request to the target:
      //   - agent: a forward-proxy http.Agent cannot speak TLS. Leaving
      //     it attached caused upstreams like deepinfra to surface as
      //     "LLM request failed: network connection error" while other
      //     upstreams that don't end up on this code path still worked.
      //     On Node 22 https.request throws a synchronous TypeError; on
      //     Node 18/20 it falls through and the TLS handshake fails.
      //   - auth: basic-auth meant for the proxy hop. Leaving it on
      //     would Basic-auth the target server with proxy credentials.
      //   - servername / checkServerIdentity: TLS SNI + cert validation
      //     pre-computed for the proxy hop. Wrong cert chain and wrong
      //     SNI must not survive into the rewrite — drop them so Node
      //     re-derives from the new `hostname`.
      //   - socketPath: Unix-socket proxies exist (e.g. cntlm-style
      //     local proxies). Routing TLS bytes into the proxy's Unix
      //     socket would defeat the entire rewrite.
      //   - localAddress / lookup / family / hints: source-binding and
      //     DNS hints picked for reachability to the proxy. The
      //     rewritten target may not be reachable from the same NIC or
      //     DNS family.
      //   - Host / hop-by-hop headers (RFC 7230 §6.1): stripped via
      //     sanitizeHeaders so Node regenerates Host from `host`/`port`
      //     to point at the real target.
      // Signal (AbortController) and TLS material (ca/cert/key/
      // rejectUnauthorized), timeout, body, and target-intent headers
      // (Authorization, Content-Type, …) are preserved.
      var rewritten = Object.assign({}, options, {
        method: options.method || 'GET',
        hostname: target.hostname,
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        protocol: 'https:',
        headers: sanitizeHeaders(options.headers),
      });
      delete rewritten.agent;
      delete rewritten.auth;
      delete rewritten.servername;
      delete rewritten.checkServerIdentity;
      delete rewritten.socketPath;
      delete rewritten.localAddress;
      delete rewritten.lookup;
      delete rewritten.family;
      delete rewritten.hints;
      return https.request(rewritten, callback);
    }
    return origRequest.apply(http, arguments);
  };
})();
