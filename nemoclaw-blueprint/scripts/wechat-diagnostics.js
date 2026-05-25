// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// wechat-diagnostics.js — adds runtime breadcrumbs for the
// @tencent-weixin/openclaw-weixin channel without changing channel behavior.
// Mirrors telegram-diagnostics.js: surfaces a single "provider ready" line
// once iLink answers a CGI call, and prints an annotated line if an agent
// turn fails after the WeChat bridge has connected so operators can tell
// "channel up, inference broken" apart from "channel never connected".

(function () {
  'use strict';

  if (process.__nemoclawWechatDiagnosticsInstalled) return;
  try {
    Object.defineProperty(process, '__nemoclawWechatDiagnosticsInstalled', { value: true });
  } catch (_e) {
    process.__nemoclawWechatDiagnosticsInstalled = true;
  }

  var providerStarted = false;
  var readyLogged = false;
  var inferenceLogged = false;
  var inDiagnosticWrite = false;

  function sanitize(value) {
    var text = String(value || '');
    // iLink puts the bot token in URL query params (?bot_token=...) and
    // sometimes in JSON bodies; redact both shapes. Keep the parameter name
    // visible so an operator can still see the request shape.
    text = text.replace(/(bot_token=)[^&\s"']+/gi, '$1<redacted>');
    text = text.replace(/("bot_token"\s*:\s*")[^"]+/gi, '$1<redacted>');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer <redacted>');
    text = text.replace(
      /\b(api[_-]?key|token|authorization|wechat[_-]?bot[_-]?token)\b(["']?\s*[:=]\s*["']?)[^"'\s,)]+/gi,
      '$1$2<redacted>'
    );
    return text;
  }

  var originalStderrWrite = process.stderr.write.bind(process.stderr);

  function emit(line) {
    if (inDiagnosticWrite) return;
    inDiagnosticWrite = true;
    try {
      originalStderrWrite(line + '\n');
    } finally {
      inDiagnosticWrite = false;
    }
  }

  function describeRequest(arg1, arg2) {
    var url = null;
    var opts = null;
    if (typeof arg1 === 'string' || arg1 instanceof URL) {
      try {
        url = new URL(String(arg1));
      } catch (_e) {
        url = null;
      }
      if (arg2 && typeof arg2 === 'object' && typeof arg2 !== 'function') opts = arg2;
    } else if (arg1 && typeof arg1 === 'object') {
      opts = arg1;
    }

    var hostname = '';
    var pathStr = '';
    if (url) {
      hostname = url.hostname || '';
      pathStr = (url.pathname || '') + (url.search || '');
    }
    if (opts) {
      hostname = String(opts.hostname || opts.host || hostname || '');
      pathStr = String(opts.path || pathStr || '');
    }
    if (hostname.indexOf(':') !== -1) hostname = hostname.split(':')[0];
    return { hostname: hostname, path: pathStr };
  }

  // The iLink gateway uses dynamic per-account subdomains under
  // *.weixin.qq.com — and *.wechat.com (e.g. ilinkai.wechat.com) — so match
  // the suffix rather than a single host. We treat any successful 2xx hit
  // on a /ilink/bot/* path as "provider ready".
  function isWechatHost(hostname) {
    if (!hostname) return false;
    return (
      hostname === 'weixin.qq.com' ||
      hostname.endsWith('.weixin.qq.com') ||
      hostname === 'wechat.com' ||
      hostname.endsWith('.wechat.com')
    );
  }

  function accountIdFromEnv() {
    var raw = process.env.WECHAT_ACCOUNT_ID;
    if (typeof raw !== 'string') return 'default';
    var trimmed = raw.trim();
    return trimmed || 'default';
  }

  function maybeLogWechatReady(info, statusCode) {
    if (readyLogged) return;
    if (!info || !isWechatHost(info.hostname)) return;
    if (info.path.indexOf('/ilink/bot/') !== 0 && info.path.indexOf('/ilink/bot') !== 0) return;
    if (Number(statusCode) < 200 || Number(statusCode) >= 300) return;
    providerStarted = true;
    readyLogged = true;
    emit('[wechat] [' + accountIdFromEnv() + '] provider ready (iLink reachable; agent replies use inference.local)');
  }

  function wrapHttp(mod, methodName) {
    var original = mod[methodName];
    if (typeof original !== 'function') return;
    mod[methodName] = function () {
      var info = describeRequest(arguments[0], arguments[1]);
      var req = original.apply(this, arguments);
      if (isWechatHost(info.hostname) && req && typeof req.once === 'function') {
        req.once('response', function (res) {
          maybeLogWechatReady(info, res && res.statusCode);
        });
      }
      return req;
    };
  }

  process.stderr.write = function (chunk, _encoding, _cb) {
    var ret = originalStderrWrite.apply(process.stderr, arguments);
    if (!inDiagnosticWrite && !inferenceLogged) {
      var text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!providerStarted && /\[wechat\]\s*\[[^\]]+\]\s*starting provider\b/i.test(text)) {
        providerStarted = true;
      }
      if (providerStarted && /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(text)) {
        inferenceLogged = true;
        var line = text.split(/\r?\n/).find(function (entry) {
          return /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(entry);
        }) || text;
        emit('[wechat] [' + accountIdFromEnv() + '] agent turn failed after provider startup; inference error: ' + sanitize(line).slice(0, 600));
      }
    }
    return ret;
  };

  var http = require('http');
  var https = require('https');
  wrapHttp(http, 'request');
  wrapHttp(http, 'get');
  wrapHttp(https, 'request');
  wrapHttp(https, 'get');
})();
