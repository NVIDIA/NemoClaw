// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// slack-token-rewriter.js — translates the Bolt-compatible placeholder
// (xoxb|xapp)-OPENSHELL-RESOLVE-ENV-VAR into the canonical
// openshell:resolve:env:VAR form on outbound HTTP, so Slack tokens travel
// the same OpenShell substitution path Discord / Telegram / Brave already
// use without any real token touching openclaw.json.
//
// Why this preload exists:
//   Slack's Bolt SDK validates token shape (^xoxb-[A-Za-z0-9_-]+$ /
//   ^xapp-…$) at App construction, before any HTTP call leaves the
//   process — so the canonical openshell:resolve:env:VAR placeholder is
//   rejected synchronously and the gateway crashes. We emit a Bolt-shape
//   placeholder into openclaw.json (which Bolt accepts), then translate
//   it back to canonical form here, just before the bytes hit the wire,
//   where OpenShell's L7 proxy substitutes the real token from env.
//
// Wraps http.request / https.request — every Node HTTP client bottoms
// out here, including @slack/web-api (axios → follow-redirects → http)
// and Bolt's Socket Mode HTTPS auth (apps.connections.open → http).
// Also wraps http.get / https.get because they call the module-local
// `request` function, not module.exports.request — wrapping `request`
// alone would miss any `get` caller.
// Request body chunks are wrapped too: Bolt's auth.test path can put the
// token in both Authorization and the urlencoded body. For Slack Web API
// requests that already carry a Slack placeholder Authorization header, that
// redundant form-body token is removed so Slack never sees an unsubstituted
// canonical placeholder. Other body placeholders continue to be translated.
//
// Invariants:
//   - No env reads. Translation is purely structural.
//   - Mutates options/headers in place. axios reuses the headers object
//     after request creation, so cloning would break the request lifecycle.
//   - Idempotent. The output (openshell:resolve:env:VAR) does not match
//     the Bolt-shape regex, so re-entering the wrapper on a retry is safe.
//   - Fast path: indexOf short-circuits the regex on the 99.9% of
//     requests that don't contain a placeholder.
//
// This file is the canonical source for review and tests. The Dockerfile
// copies it into /usr/local/lib/nemoclaw/preloads/, then at sandbox boot
// nemoclaw-start.sh writes a byte-identical copy to /tmp and loads it via
// NODE_OPTIONS=--require.
//
// Refs: https://github.com/NVIDIA/NemoClaw/issues/2085
//       https://github.com/NVIDIA/NemoClaw/issues/3315

(function () {
  'use strict';

  // Bolt-shape placeholder → canonical form. Single source of truth used
  // by every code path below. <VAR> = [A-Z_][A-Z0-9_]* — the charset
  // OpenShell's substitution layer accepts.
  var BOLT_PLACEHOLDER =
    /\b(?:xoxb|xapp)-OPENSHELL-RESOLVE-ENV-([A-Z_][A-Z0-9_]*)\b/g;
  var BOLT_SLACK_CREDENTIAL =
    /\b(?:xoxb|xapp)-OPENSHELL-RESOLVE-ENV-SLACK_(?:BOT|APP)_TOKEN\b/;
  var CANONICAL_SLACK_CREDENTIAL =
    /\bopenshell:resolve:env:SLACK_(?:BOT|APP)_TOKEN\b/;
  var CANONICAL_SLACK_FAST_PATH = 'openshell:resolve:env:SLACK_';
  var FAST_PATH = 'OPENSHELL-RESOLVE-ENV-';

  function rewriteString(s) {
    if (typeof s !== 'string') return s;
    if (s.indexOf(FAST_PATH) === -1) return s;
    return s.replace(BOLT_PLACEHOLDER, 'openshell:resolve:env:$1');
  }

  function rewriteHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      var v = headers[keys[i]];
      if (Array.isArray(v)) {
        for (var j = 0; j < v.length; j++) v[j] = rewriteString(v[j]);
      } else {
        headers[keys[i]] = rewriteString(v);
      }
    }
    return headers;
  }

  function valueContainsSlackCredentialPlaceholder(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (valueContainsSlackCredentialPlaceholder(value[i])) return true;
      }
      return false;
    }
    if (value === undefined || value === null) return false;
    var s = String(value);
    if (s.indexOf(FAST_PATH) !== -1 && BOLT_SLACK_CREDENTIAL.test(s)) return true;
    return (
      s.indexOf(CANONICAL_SLACK_FAST_PATH) !== -1 &&
      CANONICAL_SLACK_CREDENTIAL.test(s)
    );
  }

  function normalizeHostname(host) {
    if (host === undefined || host === null) return '';
    var s = String(host).trim().toLowerCase();
    if (!s) return '';
    if (s[0] === '[') return s;
    var colon = s.indexOf(':');
    if (colon !== -1) s = s.slice(0, colon);
    if (s[s.length - 1] === '.') s = s.slice(0, -1);
    return s;
  }

  function isSlackWebApiHost(host) {
    var h = normalizeHostname(host);
    return h === 'slack.com' || h === 'api.slack.com';
  }

  function isSlackWebApiPath(path) {
    if (typeof path !== 'string' || !path) return false;
    var p = path;
    try {
      if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
    } catch (_e) {
      return false;
    }
    return p === '/api' || p.indexOf('/api/') === 0;
  }

  function isSlackWebApiUrl(value) {
    if (typeof value !== 'string' && !(value instanceof URL)) return false;
    try {
      var url = value instanceof URL ? value : new URL(value);
      return isSlackWebApiHost(url.hostname) && isSlackWebApiPath(url.pathname);
    } catch (_e) {
      return false;
    }
  }

  function optionsTargetSlackWebApi(options) {
    if (!options || typeof options !== 'object') return false;
    if (typeof options.href === 'string' && isSlackWebApiUrl(options.href)) return true;
    if (typeof options.path === 'string' && isSlackWebApiUrl(options.path)) return true;
    var host = options.hostname || options.host;
    var path = options.path || options.pathname || '';
    return isSlackWebApiHost(host) && isSlackWebApiPath(path);
  }

  function requestTargetsSlackWebApi(arg1, arg2) {
    if (isSlackWebApiUrl(arg1)) return true;
    if (arg1 && typeof arg1 === 'object' && !(arg1 instanceof URL)) {
      if (optionsTargetSlackWebApi(arg1)) return true;
    }
    if (arg2 && typeof arg2 === 'object' && !(arg2 instanceof URL)) {
      if (optionsTargetSlackWebApi(arg2)) return true;
    }
    return false;
  }

  function requestRewriteState(arg1, arg2) {
    return {
      targetSlackWebApi: requestTargetsSlackWebApi(arg1, arg2),
    };
  }

  function rewriteOptions(options) {
    if (!options || typeof options !== 'object') return options;
    if (typeof options.path === 'string') {
      options.path = rewriteString(options.path);
    }
    if (options.headers) rewriteHeaders(options.headers);
    return options;
  }

  function adjustContentLength(req, beforeLength, afterLength) {
    var delta = afterLength - beforeLength;
    if (!delta || !req || typeof req.getHeader !== 'function' || typeof req.setHeader !== 'function') {
      return;
    }
    // Once Node has built/sent the header block, changing Content-Length would
    // be too late. Axios writes the urlencoded Slack body in one chunk before
    // headers are flushed, which is the path this adjustment is for.
    if (req.headersSent || req._header) return;
    var current = req.getHeader('content-length');
    if (Array.isArray(current)) current = current[0];
    if (current === undefined || current === null || current === '') return;
    var n = Number(current);
    if (!isFinite(n)) return;
    req.setHeader('Content-Length', String(n + delta));
  }

  function requestHeader(req, name) {
    if (!req || typeof req.getHeader !== 'function') return undefined;
    var value = req.getHeader(name);
    if (Array.isArray(value)) value = value[0];
    if (value === undefined || value === null) return undefined;
    return String(value);
  }

  function shouldStripSlackFormTokenParam(req) {
    if (!req || !req.__nemoclawTargetSlackWebApi) return false;
    var contentType = requestHeader(req, 'content-type');
    if (!contentType) return false;
    return (
      valueContainsSlackCredentialPlaceholder(
        requestHeader(req, 'authorization')
      ) &&
      contentType
        .split(';')[0]
        .trim()
        .toLowerCase() === 'application/x-www-form-urlencoded'
    );
  }

  function stripSlackFormTokenParam(s) {
    if (typeof s !== 'string' || s.indexOf('token') === -1) return s;
    var changed = false;
    var out = new URLSearchParams();
    var params = new URLSearchParams(s);
    params.forEach(function (value, key) {
      if (key === 'token' && valueContainsSlackCredentialPlaceholder(value)) {
        changed = true;
        return;
      }
      out.append(key, value);
    });
    return changed ? out.toString() : s;
  }

  function rewriteBodyString(req, s) {
    var rewritten = s;
    if (shouldStripSlackFormTokenParam(req)) {
      rewritten = stripSlackFormTokenParam(rewritten);
    }
    return rewriteString(rewritten);
  }

  function rewriteBodyChunk(req, chunk, encoding) {
    if (typeof chunk === 'string') {
      var rewritten = rewriteBodyString(req, chunk);
      if (rewritten !== chunk) {
        adjustContentLength(
          req,
          Buffer.byteLength(chunk, encoding),
          Buffer.byteLength(rewritten, encoding)
        );
      }
      return rewritten;
    }

    if (!chunk || typeof chunk !== 'object') return chunk;
    var isBuffer = Buffer.isBuffer(chunk);
    if (!isBuffer && !(chunk instanceof Uint8Array)) return chunk;

    var buf = isBuffer
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    var stripBodyToken = shouldStripSlackFormTokenParam(req);
    if (!stripBodyToken && buf.indexOf(FAST_PATH) === -1) return chunk;
    var s = buf.toString('utf8');
    if (!stripBodyToken && s.indexOf(FAST_PATH) === -1) return chunk;
    // Do not rewrite arbitrary binary data. Slack's urlencoded bodies are
    // valid UTF-8 and round-trip exactly.
    if (!Buffer.from(s, 'utf8').equals(buf)) return chunk;
    var rs = rewriteBodyString(req, s);
    if (rs === s) return chunk;
    var out = Buffer.from(rs, 'utf8');
    adjustContentLength(req, buf.length, out.length);
    return out;
  }

  function setRequestFlag(req, name) {
    try {
      Object.defineProperty(req, name, { value: true });
    } catch (_e) {
      req[name] = true;
    }
  }

  function wrapClientRequest(req, state) {
    if (!req || typeof req !== 'object') return req;
    if (state && state.targetSlackWebApi) {
      setRequestFlag(req, '__nemoclawTargetSlackWebApi');
    }
    if (req.__nemoclawSlackTokenRewriter) return req;
    setRequestFlag(req, '__nemoclawSlackTokenRewriter');

    var origWrite = req.write;
    if (typeof origWrite === 'function') {
      req.write = function (chunk, encoding, cb) {
        if (typeof encoding === 'function') {
          cb = encoding;
          encoding = undefined;
        }
        chunk = rewriteBodyChunk(this, chunk, encoding);
        if (cb) return origWrite.call(this, chunk, encoding, cb);
        if (encoding !== undefined) return origWrite.call(this, chunk, encoding);
        return origWrite.call(this, chunk);
      };
    }

    var origEnd = req.end;
    if (typeof origEnd === 'function') {
      req.end = function (chunk, encoding, cb) {
        if (arguments.length === 0) return origEnd.call(this);
        if (typeof chunk === 'function') return origEnd.call(this, chunk);
        if (typeof encoding === 'function') {
          cb = encoding;
          encoding = undefined;
        }
        if (chunk !== undefined && chunk !== null) {
          chunk = rewriteBodyChunk(this, chunk, encoding);
        }
        if (cb) return origEnd.call(this, chunk, encoding, cb);
        if (encoding !== undefined) return origEnd.call(this, chunk, encoding);
        return origEnd.call(this, chunk);
      };
    }

    return req;
  }

  function wrap(mod, methodName) {
    var orig = mod[methodName];
    if (typeof orig !== 'function') return;
    mod[methodName] = function (arg1, arg2, arg3) {
      // Signatures: m(options[, cb]); m(url[, options][, cb])
      if (typeof arg1 === 'string') {
        arg1 = rewriteString(arg1);
        if (arg2 && typeof arg2 === 'object' && typeof arg2 !== 'function') {
          rewriteOptions(arg2);
        }
      } else if (arg1 instanceof URL) {
        // URL instances are immutable by component; rebuild only if needed.
        var s = arg1.href;
        var rs = rewriteString(s);
        if (rs !== s) arg1 = new URL(rs);
        if (arg2 && typeof arg2 === 'object' && typeof arg2 !== 'function') {
          rewriteOptions(arg2);
        }
      } else {
        rewriteOptions(arg1);
      }
      return wrapClientRequest(orig.call(this, arg1, arg2, arg3), requestRewriteState(arg1, arg2));
    };
  }

  var http = require('http');
  var https = require('https');
  wrap(http, 'request');
  wrap(http, 'get');
  wrap(https, 'request');
  wrap(https, 'get');
})();
