// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// nemotron-inference-fix.js — inject chat_template_kwargs for affected models.
//
// Problem (NemoClaw#1193, NemoClaw#2051):
//   Nemotron models sometimes generate tool calls instead of text for simple
//   queries, or return thinking-only blocks with stopReason "stop" that
//   OpenClaw treats as end-of-turn, causing the conversation to stall.
//   The root cause is the model's chat template producing empty assistant
//   content when tool definitions are present.
//
// Fix:
//   Inject `chat_template_kwargs: { force_nonempty_content: true }` into
//   /v1/chat/completions request bodies when the model ID contains
//   "nemotron". This tells the vLLM/NIM serving layer to force the chat
//   template to always produce non-empty content alongside any tool calls
//   or thinking blocks.
//
//   Also inject `chat_template_kwargs: { thinking: false }` for
//   deepseek-ai/deepseek-v4-pro and moonshotai/kimi-k2.6, matching NVIDIA
//   Build's tested invocation shape for the OpenAI-compatible
//   chat-completions endpoint.
//
//   Scoped strictly to known affected models — all other requests pass
//   through untouched. Backends that do not support chat_template_kwargs
//   silently ignore the extra field per the OpenAI-compatible API contract.
//
// Source-of-truth / removal contract (NemoClaw#4063):
//   Invalid state: sandboxed OpenClaw channel clients can send NVIDIA Build
//   OpenAI-compatible chat-completions requests for DeepSeek V4 Pro / Kimi
//   K2.6 without `chat_template_kwargs.thinking=false`, which routes simple
//   channel prompts through the slow thinking path observed as multi-minute
//   Discord and WeChat latency.
//
//   Source boundary: NemoClaw owns the sandbox entrypoint and preload layer,
//   while the request origin may be OpenClaw, OpenAI-compatible SDKs, or other
//   bundled channel clients that choose either http.request()/https.request()
//   or Node's fetch()/undici transport. The NVIDIA endpoint chat-template
//   contract is outside this repository.
//
//   Why not fix only at the origin: the same sandbox must protect multiple
//   client transports and third-party SDK versions without vendoring OpenClaw
//   or every OpenAI-compatible caller. A preload keeps the workaround local to
//   sandboxed chat-completions traffic until the upstream clients/providers
//   always emit the model-specific kwargs themselves.
//
//   Regression proof: test/nemotron-inference-fix.test.ts covers the helper
//   logic, the http/https path, and a real Node fetch/undici request to a local
//   OpenAI-compatible endpoint. The request fails before reaching the endpoint
//   if this wrapper leaves a stale Content-Length after injecting kwargs.
//
//   Removal condition: remove this preload branch once the upstream client or
//   provider configuration always sends the required model-specific kwargs (or
//   NVIDIA Build no longer requires them) and the DeepSeek/Kimi channel latency
//   validation passes without the monkeypatch.

(function () {
  'use strict';

  var http = require('http');
  var https = require('https');

  var COMPLETIONS_RE = /\/v1\/chat\/completions/;
  var CHAT_TEMPLATE_KWARG_RULES = [
    { pattern: /nemotron/i, kwargs: { force_nonempty_content: true } },
    { pattern: /^deepseek-ai\/deepseek-v4-pro$/i, kwargs: { thinking: false } },
    { pattern: /^moonshotai\/kimi-k2\.6$/i, kwargs: { thinking: false } },
  ];

  function chatTemplateKwargsForModel(model) {
    var kwargs = null;
    CHAT_TEMPLATE_KWARG_RULES.forEach(function (rule) {
      if (!rule.pattern.test(model)) return;
      kwargs = kwargs || {};
      Object.keys(rule.kwargs).forEach(function (key) {
        kwargs[key] = rule.kwargs[key];
      });
    });
    return kwargs;
  }

  function hasObjectChatTemplateKwargs(body) {
    return (
      body.chat_template_kwargs &&
      typeof body.chat_template_kwargs === 'object' &&
      !Array.isArray(body.chat_template_kwargs)
    );
  }

  function applyChatTemplateKwargs(body) {
    var kwargs = body && body.model ? chatTemplateKwargsForModel(body.model) : null;
    if (!kwargs) return false;

    if (!hasObjectChatTemplateKwargs(body)) {
      body.chat_template_kwargs = {};
    }
    Object.keys(kwargs).forEach(function (key) {
      body.chat_template_kwargs[key] = kwargs[key];
    });
    return true;
  }

  function patchJsonBody(raw) {
    try {
      var body = JSON.parse(raw.toString('utf-8'));
      if (!applyChatTemplateKwargs(body)) {
        return null;
      }
      return Buffer.from(JSON.stringify(body), 'utf-8');
    } catch (_e) {
      return null;
    }
  }

  function isChatCompletionsPost(method, pathOrUrl) {
    return (
      String(method || 'GET').toUpperCase() === 'POST' &&
      COMPLETIONS_RE.test(pathOrUrl || '')
    );
  }

  function fetchMethod(input, init) {
    return (init && init.method) || (input && input.method) || 'GET';
  }

  function fetchUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    if (input && typeof input.href === 'string') return input.href;
    return '';
  }

  function isChatCompletionsFetch(input, init) {
    return isChatCompletionsPost(fetchMethod(input, init), fetchUrl(input));
  }

  function headersWithoutContentLength(headers) {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      var copy = new Headers(headers);
      copy.delete('content-length');
      return copy;
    }
    if (Array.isArray(headers)) {
      return headers.filter(function (entry) {
        return !entry || String(entry[0]).toLowerCase() !== 'content-length';
      });
    }
    if (headers && typeof headers === 'object') {
      var next = {};
      Object.keys(headers).forEach(function (key) {
        if (key.toLowerCase() !== 'content-length') {
          next[key] = headers[key];
        }
      });
      return next;
    }
    return headers;
  }

  function bytesFromSimpleBody(body) {
    if (typeof body === 'string') return Promise.resolve(Buffer.from(body, 'utf-8'));
    if (Buffer.isBuffer(body)) return Promise.resolve(body);
    if (body instanceof Uint8Array) return Promise.resolve(Buffer.from(body));
    if (body instanceof ArrayBuffer) return Promise.resolve(Buffer.from(body));
    return null;
  }

  function bytesFromFetch(input, init) {
    var bytes = bytesFromSimpleBody(init && init.body);
    if (bytes || typeof Request === 'undefined' || !(input instanceof Request)) {
      return bytes;
    }
    try {
      return input.clone().arrayBuffer().then(function (buf) {
        return Buffer.from(buf);
      });
    } catch (_e) {
      return null;
    }
  }

  function addChunk(chunks, chunk, encoding) {
    if (chunk == null) return;
    if (typeof chunk === 'string') {
      var chunkEncoding = typeof encoding === 'string' ? encoding : undefined;
      chunks.push(Buffer.from(chunk, chunkEncoding));
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }

  function writeCallback(encoding, cb) {
    if (typeof encoding === 'function') return encoding;
    if (typeof cb === 'function') return cb;
    return null;
  }

  function endCallback(chunk, encoding, cb) {
    if (typeof chunk === 'function') return chunk;
    if (typeof encoding === 'function') return encoding;
    if (typeof cb === 'function') return cb;
    return null;
  }

  function wrapFetch() {
    if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__nemoclawInferenceFix) {
      return;
    }

    var origFetch = globalThis.fetch;
    var wrappedFetch = async function (input, init) {
      if (!isChatCompletionsFetch(input, init)) {
        return origFetch.apply(this, arguments);
      }

      var nextInit = init ? Object.assign({}, init) : {};
      var rawPromise = bytesFromFetch(input, nextInit);
      if (!rawPromise) {
        return origFetch.apply(this, arguments);
      }

      var modified = patchJsonBody(await rawPromise);
      if (!modified) {
        return origFetch.apply(this, arguments);
      }

      nextInit.body = modified.toString('utf-8');
      nextInit.headers = headersWithoutContentLength(
        nextInit.headers || (input && input.headers)
      );
      return origFetch.call(this, input, nextInit);
    };
    wrappedFetch.__nemoclawInferenceFix = true;
    globalThis.fetch = wrappedFetch;
  }

  function wrapModule(mod) {
    var origRequest = mod.request;

    mod.request = function (options, callback) {
      // Only intercept object-form calls with a recognisable path.
      if (typeof options === 'string' || !options) {
        return origRequest.apply(mod, arguments);
      }

      var path = options.path || '';
      if (!isChatCompletionsPost(options.method, path)) {
        return origRequest.apply(mod, arguments);
      }

      // Create the real request, then intercept write/end to buffer the body.
      var req = origRequest.apply(mod, arguments);
      var origWrite = req.write;
      var origEnd = req.end;
      var chunks = [];

      req.write = function (chunk, encoding, cb) {
        addChunk(chunks, chunk, encoding);
        var done = writeCallback(encoding, cb);
        if (done) done();
        return true;
      };

      req.end = function (chunk, encoding, cb) {
        if (typeof chunk !== 'function') {
          addChunk(chunks, chunk, encoding);
        }

        var raw = Buffer.concat(chunks);
        var modified = patchJsonBody(raw);
        var bodyToSend = modified || raw;
        if (modified && req.getHeader && req.setHeader) {
          req.removeHeader('content-length');
          req.setHeader('Content-Length', modified.length);
        }
        origWrite.call(req, bodyToSend);

        var done = endCallback(chunk, encoding, cb);
        return done ? origEnd.call(req, done) : origEnd.call(req);
      };

      return req;
    };
  }

  wrapModule(http);
  wrapModule(https);
  wrapFetch();
})();
