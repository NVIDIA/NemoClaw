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
      // Clone caller's options and overwrite only the proxy-specific
      // routing fields. Preserves signal (AbortController), lookup,
      // TLS fields (ca/cert/key/rejectUnauthorized), auth, timeout,
      // and any other per-request setting the caller supplied.
      var rewritten = Object.assign({}, options, {
        method: options.method || 'GET',
        hostname: target.hostname,
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        protocol: 'https:',
      });
      return https.request(rewritten, callback);
    }
    return origRequest.apply(http, arguments);
  };
})();
