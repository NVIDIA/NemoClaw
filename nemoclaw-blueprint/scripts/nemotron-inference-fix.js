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
//
// Source-of-truth / removal contract (NemoClaw#4851):
//   Invalid state: nvidia/nemotron-3-ultra-550b plans multi-step tasks
//   correctly in `reasoning_content` but silently drops intermediate steps
//   from `content` when the request has no execution-capable tools and no
//   caller-supplied system message. force_nonempty_content does not address
//   this — verified via direct curl with and without that kwarg.
//
//   Source boundary: the chat template / vLLM-NIM serving stack for this
//   model on NVIDIA Build is the actual origin; the model's emission shape
//   is outside this repository. Inside the sandbox we own the preload that
//   wraps every chat-completions request on the way out.
//
//   Why not fix only at the origin: the NVIDIA Build chat template + Ultra
//   weight pairing is owned upstream. NVB#6272828 tracks the upstream fix.
//   Until that lands, a sandbox-side preload is the only way to keep the
//   Ultra path usable in the niche tool-less configuration that triggers
//   the bug.
//
//   Regression proof: test/nemotron-inference-fix.test.ts covers the
//   inject/skip branches via the http stub AND a real fetch/undici request
//   against a local OpenAI-compatible endpoint, asserting both the injected
//   system message and the refreshed Content-Length. The runtime model-
//   output behavior (acceptance criteria from #4851) is validated against
//   integrate.api.nvidia.com via the checked-in runbook at
//   test/e2e-runtime/4851-ultra-toolless-validation.md — anyone reviewing
//   acceptance can re-run it directly. Re-run when this preload changes
//   or when OpenClaw bumps a version that may shift Ultra's chat template.
//
//   Removal condition: remove the TOOL_LESS_SYSTEM_PROMPT_RULES entry for
//   Ultra 550B once NVB#6272828 ships and a clean Ultra response to the
//   #4851 prompt no longer requires the nudge.

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

  // #4851: Ultra 550B silently drops intermediate steps from `content` when
  // asked to perform multi-step tasks without execution-capable tools —
  // reasoning plans all steps but content emits only the final command (or
  // empty). chat_template_kwargs.force_nonempty_content doesn't help. When
  // the caller hasn't supplied a system message AND has no execution-
  // capable tools, inject a one-paragraph nudge so the model emits the full
  // code/commands the user would run manually. Skip when a system message
  // is already present anywhere in the array (caller's prompt wins) or
  // when execution-capable tools are present (the model should use them).
  //
  // Scope boundary: this preload runs inside NemoClaw-managed sandboxes
  // where the chat-completions destination is the OpenShell-gateway
  // `inference.local` route bound to NVIDIA Build. The path+model regex
  // is the intentional trust boundary; non-sandbox OpenAI-compatible
  // callers do not load this preload.
  var TOOL_LESS_SYSTEM_PROMPT_RULES = [
    {
      pattern: /^nvidia\/nemotron-3-ultra-550b/i,
      systemPrompt:
        'You do not have tools to write files or execute commands. When the user asks you to perform such actions, include the complete code or command they would need to run manually. Do not skip steps.',
    },
  ];

  // Tools that signal the agent has execution capability — when any of
  // these are in the request, the tool-less nudge above doesn't apply
  // because the model should call the tool. Search/web/fetch/describe/read
  // tools are intentionally NOT in this set: they don't let the model
  // write a file or run a command, so they don't change the "no way to
  // perform the asked action" condition that #4851 cares about.
  //
  // Tight allowlist (not a broad regex) to avoid false positives on
  // harmless business tools like `create_ticket`, `run_query`, `save_search`,
  // `command_palette` that contain "create"/"run"/"save"/"command" but don't
  // give the model the ability to write a file or execute a shell command.
  // Match exact known names + the canonical OpenClaw/MCP suffixes.
  //
  // The bare `write`, `edit`, and `notebook_edit` names mirror
  // `nemoclaw/src/index.ts:WRITE_TOOL_NAMES` so this allowlist stays
  // aligned with the same write-capable surface OpenClaw scans for
  // secrets. `tool_call` is the OpenClaw compact-catalog wrapper from
  // `scripts/patch-openclaw-tool-catalog.js` — when it's present we
  // can't tell from the request alone which underlying tool will be
  // dispatched, so treat it as execution-capable and skip the nudge.
  var EXECUTION_TOOL_NAMES = new Set([
    'bash',
    'bash_execute',
    'exec',
    'execute',
    'execute_command',
    'shell',
    'shell_execute',
    'run_command',
    'run_shell',
    'write',
    'write_file',
    'file_write',
    'edit',
    'edit_file',
    'file_edit',
    'notebook_edit',
    'patch_file',
    'file_patch',
    'create_file',
    'file_create',
    'apply_patch',
    'str_replace_editor',
    'computer',
    'tool_call',
  ]);

  function isExecutionCapableTool(tool) {
    if (!tool || typeof tool !== 'object') return false;
    // OpenAI chat-completions tool shape: { type: 'function', function: { name: ... } }
    var name = null;
    if (typeof tool.name === 'string') {
      name = tool.name;
    } else if (tool.function && typeof tool.function.name === 'string') {
      name = tool.function.name;
    }
    if (!name) return false;
    return EXECUTION_TOOL_NAMES.has(name.toLowerCase());
  }

  function hasExecutionCapableTool(body) {
    if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
    return body.tools.some(isExecutionCapableTool);
  }

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

  function toolLessSystemPromptForModel(body) {
    if (!body || typeof body.model !== 'string') return null;
    var rule = null;
    for (var i = 0; i < TOOL_LESS_SYSTEM_PROMPT_RULES.length; i++) {
      if (TOOL_LESS_SYSTEM_PROMPT_RULES[i].pattern.test(body.model)) {
        rule = TOOL_LESS_SYSTEM_PROMPT_RULES[i];
        break;
      }
    }
    if (!rule) return null;
    if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
    // Scan ALL messages, not just messages[0]: the OpenAI chat-completions
    // contract permits a system message anywhere in the array, and the
    // "caller prompt wins" contract should hold for any of those positions.
    var hasSystemMessage = body.messages.some(function (msg) {
      return msg && typeof msg === 'object' && msg.role === 'system';
    });
    if (hasSystemMessage) return null;
    // Skip when execution-capable tools are present; harmless tools like
    // tool_search / web fetch / file describe don't change the "no way to
    // perform the asked action" condition #4851 cares about.
    if (hasExecutionCapableTool(body)) return null;
    return rule.systemPrompt;
  }

  function applyToolLessSystemPrompt(body) {
    var systemPrompt = toolLessSystemPromptForModel(body);
    if (!systemPrompt) return false;
    body.messages.unshift({ role: 'system', content: systemPrompt });
    return true;
  }

  function patchJsonBody(raw) {
    try {
      var body = JSON.parse(raw.toString('utf-8'));
      var changed = false;
      if (applyChatTemplateKwargs(body)) changed = true;
      if (applyToolLessSystemPrompt(body)) changed = true;
      if (!changed) return null;
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
