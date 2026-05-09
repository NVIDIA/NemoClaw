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
//   deepseek-ai/deepseek-v4-pro, matching NVIDIA Build's tested invocation
//   shape for the OpenAI-compatible chat-completions endpoint.
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
  var COMPLETIONS_RE = /\/v1\/chat\/completions/;

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
        try {
          var body = JSON.parse(raw.toString('utf-8'));
          if (body && body.model && (NEMOTRON_RE.test(body.model) || DEEPSEEK_V4_PRO_RE.test(body.model))) {
            if (!body.chat_template_kwargs) {
              body.chat_template_kwargs = {};
            }
            if (NEMOTRON_RE.test(body.model)) {
              body.chat_template_kwargs.force_nonempty_content = true;
            }
            if (DEEPSEEK_V4_PRO_RE.test(body.model)) {
              body.chat_template_kwargs.thinking = false;
            }
            intercepted = true;
            var modified = Buffer.from(JSON.stringify(body), 'utf-8');
            // Update Content-Length so the proxy/server reads the full body.
            if (req.getHeader && req.setHeader) {
              req.removeHeader('content-length');
              req.setHeader('Content-Length', modified.length);
            }
            origWrite.call(req, modified);
          } else {
            // Not a Nemotron model — send original bytes unmodified.
            origWrite.call(req, raw);
          }
        } catch (_e) {
          // JSON parse failed — forward original bytes.
          origWrite.call(req, raw);
        }

        return endCb ? origEnd.call(req, endCb) : origEnd.call(req);
      };

      return req;
    };
  }

  wrapModule(http);
  wrapModule(https);
})();
