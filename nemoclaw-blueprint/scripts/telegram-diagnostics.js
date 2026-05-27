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
  var startupProbeLogged = false;
  var inferenceLogged = false;
  var credentialLogged = false;
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

  function isTelegramStartupProbe(info) {
    if (!info || info.hostname !== 'api.telegram.org') return;
    return /\/(?:bot[^/]+\/)?(?:getUpdates|getMe|getWebhookInfo)(?:\?|$)/.test(info.path);
  }

  function maybeLogTelegramStartupProbe(info, statusCode) {
    if (!isTelegramStartupProbe(info)) return;
    providerStarted = true;
    var status = Number(statusCode);
    if (status >= 200 && status < 300) {
      if (readyLogged) return;
      readyLogged = true;
      emit('[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)');
      return;
    }
    if (startupProbeLogged) return;
    startupProbeLogged = true;
    if (status === 401 || status === 404) {
      emit('[telegram] [default] Bot API rejected startup probe with HTTP ' + status + '; token invalid or credential placeholder unresolved');
      return;
    }
    if (status >= 300) {
      emit('[telegram] [default] Bot API startup probe returned HTTP ' + status);
    }
  }

  function maybeLogTelegramStartupError(info, error) {
    if (!isTelegramStartupProbe(info) || startupProbeLogged) return;
    providerStarted = true;
    startupProbeLogged = true;
    var detail = error && (error.code || error.message) ? (error.code || error.message) : error;
    emit('[telegram] [default] Bot API startup probe failed: ' + sanitize(detail).slice(0, 300));
  }

  function readTelegramBotToken(config) {
    if (!config || typeof config !== 'object') return '';
    var channel = config.channels && config.channels.telegram;
    if (!channel || typeof channel !== 'object') return '';
    var accounts = channel.accounts;
    if (!accounts || typeof accounts !== 'object') return '';
    var account = accounts.default || accounts.main;
    if (!account || typeof account !== 'object') {
      var keys = Object.keys(accounts);
      account = keys.length ? accounts[keys[0]] : null;
    }
    return account && typeof account.botToken === 'string' ? account.botToken : '';
  }

  function maybeLogCredentialPlaceholderDiagnostics() {
    if (credentialLogged) return;
    credentialLogged = true;
    var prefix = 'openshell:resolve:env:';
    var envToken = process.env.TELEGRAM_BOT_TOKEN || '';
    var configPath = process.env.OPENCLAW_CONFIG_PATH || '/sandbox/.openclaw/openclaw.json';
    var configToken = '';
    try {
      var fs = require('fs');
      configToken = readTelegramBotToken(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch (_e) {
      return;
    }
    if (!configToken || configToken.indexOf(prefix) !== 0) return;
    if (!envToken) {
      emit('[telegram] [default] credential placeholder configured but TELEGRAM_BOT_TOKEN is missing from runtime env');
      return;
    }
    if (envToken.indexOf(prefix) !== 0) return;
    if (configToken !== envToken) {
      emit('[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder');
    }
  }

  function wrapHttp(mod, methodName) {
    var original = mod[methodName];
    if (typeof original !== 'function') return;
    mod[methodName] = function () {
      var info = describeRequest(arguments[0], arguments[1]);
      var req = original.apply(this, arguments);
      if (info && info.hostname === 'api.telegram.org' && req && typeof req.once === 'function') {
        req.once('response', function (res) {
          maybeLogTelegramStartupProbe(info, res && res.statusCode);
        });
        req.once('error', function (error) {
          maybeLogTelegramStartupError(info, error);
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
  process.nextTick(maybeLogCredentialPlaceholderDiagnostics);
})();
