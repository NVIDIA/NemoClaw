// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// telegram-diagnostics.js — adds runtime breadcrumbs for OpenClaw's Telegram
// channel without changing channel behavior. The important distinction for
// NemoClaw#2766 is that "[telegram] [default] starting provider" means the
// channel is initializing; an agent-turn failure later can be an inference
// provider failure through inference.local, not a Telegram Bot API failure.

(function () {
  'use strict';

  if (process.__nemoclawTelegramDiagnosticsInstalled) return;
  try {
    Object.defineProperty(process, '__nemoclawTelegramDiagnosticsInstalled', { value: true });
  } catch (_e) {
    process.__nemoclawTelegramDiagnosticsInstalled = true;
  }

  var providerStarted = false;
  var readyLogged = false;
  var inferenceLogged = false;
  var inDiagnosticWrite = false;

  function sanitize(value) {
    var text = String(value || '');
    text = text.replace(/\/bot[^/\s"']+/g, '/bot<redacted>');
    text = text.replace(/\/file\/bot[^/\s"']+/g, '/file/bot<redacted>');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer <redacted>');
    text = text.replace(
      /\b(api[_-]?key|token|authorization)\b(["']?\s*[:=]\s*["']?)[^"'\s,)]+/gi,
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
    var path = '';
    if (url) {
      hostname = url.hostname || '';
      path = (url.pathname || '') + (url.search || '');
    }
    if (opts) {
      hostname = String(opts.hostname || opts.host || hostname || '');
      path = String(opts.path || path || '');
    }
    if (hostname.indexOf(':') !== -1) hostname = hostname.split(':')[0];
    return { hostname: hostname, path: path };
  }

  function maybeLogTelegramReady(info, statusCode) {
    if (readyLogged) return;
    if (!info || info.hostname !== 'api.telegram.org') return;
    if (!/\/(?:bot[^/]+\/)?(?:getUpdates|getMe|getWebhookInfo)(?:\?|$)/.test(info.path)) return;
    if (Number(statusCode) < 200 || Number(statusCode) >= 300) return;
    providerStarted = true;
    readyLogged = true;
    emit('[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)');
  }

  function wrapHttp(mod, methodName) {
    var original = mod[methodName];
    if (typeof original !== 'function') return;
    mod[methodName] = function () {
      var info = describeRequest(arguments[0], arguments[1]);
      var req = original.apply(this, arguments);
      if (info && info.hostname === 'api.telegram.org' && req && typeof req.once === 'function') {
        req.once('response', function (res) {
          maybeLogTelegramReady(info, res && res.statusCode);
        });
      }
      return req;
    };
  }

  process.stderr.write = function (chunk, encoding, cb) {
    var ret = originalStderrWrite.apply(process.stderr, arguments);
    if (!inDiagnosticWrite && !inferenceLogged) {
      var text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!providerStarted && /\[telegram\] \[default\] starting provider\b/i.test(text)) {
        providerStarted = true;
      }
      if (providerStarted && /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(text)) {
        inferenceLogged = true;
        var line = text.split(/\r?\n/).find(function (entry) {
          return /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(entry);
        }) || text;
        emit('[telegram] [default] agent turn failed after provider startup; inference error: ' + sanitize(line).slice(0, 600));
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
