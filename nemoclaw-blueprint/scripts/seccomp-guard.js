// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// seccomp-guard.js — patch syscalls that are blocked by OpenShell ≥0.0.36
// seccomp policy. Third-party libraries (e.g., @homebridge/ciao mDNS) call
// os.networkInterfaces() without error handling, producing unhandled promise
// rejections. OpenClaw's rejection handler (unhandled-rejections-*.js) calls
// process.exit(1) for unrecognised errors, crashing the gateway.
//
// Rather than trying to catch the rejection (which races with OpenClaw's own
// handler), this preload patches the syscall wrappers to return safe defaults
// when the underlying call is blocked by seccomp.

(function () {
  'use strict';
  var os = require('os');
  var _origNetworkInterfaces = os.networkInterfaces;

  os.networkInterfaces = function () {
    try {
      return _origNetworkInterfaces.call(os);
    } catch (err) {
      if (err && String(err.message || '').indexOf('uv_interface_addresses') !== -1) {
        // seccomp blocks getifaddrs — return empty result.
        // mDNS discovery is not needed inside a sandbox.
        return {};
      }
      throw err;
    }
  };
})();
