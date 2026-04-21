#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// axios-proxy-fix.js — preload script to resolve the double-proxy conflict
// between axios and NODE_USE_ENV_PROXY=1 (Node.js 22+).
//
// Problem (NemoClaw#2109):
//   When NODE_USE_ENV_PROXY=1 is set (baked into the OpenShell base image),
//   Node.js 22 intercepts all https.request() calls and routes them through the
//   L7 proxy via a CONNECT tunnel. axios ALSO reads HTTPS_PROXY and configures
//   its own proxy — resulting in the request being processed twice:
//
//     axios → proxy CONNECT to 10.200.0.1:3128 → "https://clawhub.ai:3128/"
//                                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                                  port leaked into host → DENIED
//
//   NODE_USE_ENV_PROXY alone handles the CONNECT tunnel correctly. axios's
//   built-in proxy handling is redundant and conflicting.
//
// Fix:
//   Intercept the first axios require() and set proxy: false on its defaults.
//   Restore Module._load immediately after to avoid ongoing overhead.
//   An idempotency guard prevents double-patching if the script is loaded twice.

'use strict';

if (process.env.NODE_USE_ENV_PROXY !== '1') return;

const Module = require('module');
const _PATCHED = Symbol.for('nemoclaw.axiosProxyFix');

// Idempotency guard — safe if this script is required more than once
if (Module[_PATCHED]) return;
Module[_PATCHED] = 'installing';

const _originalLoad = Module._load;

Module._load = function (request, _parent, _isMain) {
  const result = _originalLoad.apply(this, arguments);

  if (
    (request === 'axios' || (typeof request === 'string' && request.endsWith('/axios/index.js'))) &&
    result &&
    typeof result === 'function' &&
    result.defaults !== undefined &&
    result.defaults.proxy === undefined
  ) {
    // Disable axios's own proxy handling so NODE_USE_ENV_PROXY handles HTTPS
    // via CONNECT tunnel without double-processing the request.
    result.defaults.proxy = false;

    // Restore Module._load now that axios has been patched — no ongoing overhead
    Module._load = _originalLoad;
    Module[_PATCHED] = 'done';
  }

  return result;
};

// Mark as installed (axios not yet loaded)
if (Module[_PATCHED] !== 'done') {
  Module[_PATCHED] = 'installed';
}
