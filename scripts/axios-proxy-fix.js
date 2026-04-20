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
//   Disable axios's own proxy handling (proxy: false) at module load time when
//   NODE_USE_ENV_PROXY=1 is detected. Node.js continues to route HTTPS through
//   the L7 proxy via its engine-level CONNECT tunnel — which axios then inherits
//   transparently through https.request().
//
// Scope:
//   Only active when NODE_USE_ENV_PROXY=1 is set — safe to deploy unconditionally
//   on all sandbox instances.

'use strict';

if (process.env.NODE_USE_ENV_PROXY === '1') {
  try {
    const Module = require('module');
    const originalLoad = Module._load;

    Module._load = function (request, parent, isMain) {
      const result = originalLoad.apply(this, arguments);
      // Patch axios when it is first loaded
      if (
        (request === 'axios' || request.endsWith('/axios/index.js')) &&
        result &&
        result.defaults &&
        result.defaults.proxy === undefined
      ) {
        result.defaults.proxy = false;
      }
      return result;
    };
  } catch {
    // Non-fatal: if patching fails, axios falls back to default behavior
  }
}
