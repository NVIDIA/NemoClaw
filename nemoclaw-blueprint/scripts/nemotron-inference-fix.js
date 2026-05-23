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

(function () {
  'use strict';

  var http = require('http');
  var https = require('https');

  var NEMOTRON_RE = /nemotron/i;
  var DEEPSEEK_V4_PRO_RE = /^deepseek-ai\/deepseek-v4-pro$/i;
  var KIMI_K26_RE = /^moonshotai\/kimi-k2\.6$/i;
  var COMPLETIONS_RE = /\/v1\/chat\/completions/;

  function hasObjectChatTemplateKwargs(body) {
    return (
      body.chat_template_kwargs &&
      typeof body.chat_template_kwargs === 'object' &&
      !Array.isArray(body.chat_template_kwargs)
    );
  }

  function shouldPatchModel(model) {
    return (
      NEMOTRON_RE.test(model) ||
      DEEPSEEK_V4_PRO_RE.test(model) ||
      KIMI_K26_RE.test(model)
    );
  }

  function patchBody(body) {
    if (!body || !body.model || !shouldPatchModel(body.model)) {
      return false;
    }
    if (!hasObjectChatTemplateKwargs(body)) {
      body.chat_template_kwargs = {};
    }
    if (NEMOTRON_RE.test(body.model)) {
      body.chat_template_kwargs.force_nonempty_content = true;
    }
    if (DEEPSEEK_V4_PRO_RE.test(body.model) || KIMI_K26_RE.test(body.model)) {
      body.chat_template_kwargs.thinking = false;
    }
    return true;
  }

  function patchRawBody(raw) {
    try {
      var body = JSON.parse(raw.toString('utf-8'));
      if (!patchBody(body)) {
        return null;
      }
      return Buffer.from(JSON.stringify(body), 'utf-8');
    } catch (_e) {
      return null;
    }
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

  function isChatCompletionsFetch(input, init) {
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'POST') return false;
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    } else if (input && typeof input.href === 'string') {
      url = input.href;
    }
    return COMPLETIONS_RE.test(url);
  }

  function bytesFromSimpleBody(body) {
    if (typeof body === 'string') return Promise.resolve(Buffer.from(body, 'utf-8'));
    if (Buffer.isBuffer(body)) return Promise.resolve(body);
    if (body instanceof Uint8Array) return Promise.resolve(Buffer.from(body));
    if (body instanceof ArrayBuffer) return Promise.resolve(Buffer.from(body));
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
      var rawPromise = bytesFromSimpleBody(nextInit.body);
      if (!rawPromise && typeof Request !== 'undefined' && input instanceof Request) {
        try {
          rawPromise = input.clone().arrayBuffer().then(function (buf) {
            return Buffer.from(buf);
          });
        } catch (_e) {
          rawPromise = null;
        }
      }

      if (!rawPromise) {
        return origFetch.apply(this, arguments);
      }

      var modified = patchRawBody(await rawPromise);
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
      if (options.method !== 'POST' || !COMPLETIONS_RE.test(path)) {
        return origRequest.apply(mod, arguments);
      }

      // Create the real request, then intercept write/end to buffer the body.
      var req = origRequest.apply(mod, arguments);
      var origWrite = req.write;
      var origEnd = req.end;
      var chunks = [];
      var intercepted = false;

      req.write = function (chunk, encoding, cb) {
        if (chunk != null) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
        }
        // Buffer instead of sending — we flush in end().
        if (typeof encoding === 'function') { encoding(); }
        else if (typeof cb === 'function') { cb(); }
        return true;
      };

      req.end = function (chunk, encoding, cb) {
        if (chunk != null && typeof chunk !== 'function') {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
        }
        // Resolve the callback argument (end has multiple overload signatures).
        var endCb = typeof chunk === 'function' ? chunk
          : typeof encoding === 'function' ? encoding
          : typeof cb === 'function' ? cb
          : null;

        var raw = Buffer.concat(chunks);
        var modified = patchRawBody(raw);
        if (modified) {
          intercepted = true;
          // Update Content-Length so the proxy/server reads the full body.
          if (req.getHeader && req.setHeader) {
            req.removeHeader('content-length');
            req.setHeader('Content-Length', modified.length);
          }
          origWrite.call(req, modified);
        } else {
          // Not an affected model or not JSON — send original bytes unmodified.
          origWrite.call(req, raw);
        }

        return endCb ? origEnd.call(req, endCb) : origEnd.call(req);
      };

      return req;
    };
  }

  wrapModule(http);
  wrapModule(https);
  wrapFetch();
})();
