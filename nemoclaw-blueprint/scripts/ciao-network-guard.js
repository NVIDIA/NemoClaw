// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// ciao-network-guard.js — prevents @homebridge/ciao mDNS library from
// crashing the gateway when os.networkInterfaces() fails in restricted
// sandbox network namespaces.

(function () {
  'use strict';

  function basename(value) {
    return String(value || '').split(/[\\/]/).pop();
  }

  function gatewayProcessFlavor() {
    if (basename(process.argv0) === 'openclaw-gateway') return 'openclaw-gateway';
    if (basename(process.title) === 'openclaw-gateway') return 'openclaw-gateway';
    if (process.argv[2] === 'gateway') return 'launcher';
    if (basename(process.argv[1]) === 'openclaw-gateway') return 'openclaw-gateway';
    if (basename(process.argv[0]) === 'openclaw-gateway') return 'openclaw-gateway';
    return '';
  }

  var _gatewayProcess = gatewayProcessFlavor();
  if (_gatewayProcess) {
    try {
      process.stderr.write('[guard] ciao-network-guard loaded (' + _gatewayProcess + ')\n');
    } catch (_) {}
  }

  // Monkey-patch os.networkInterfaces to return empty on failure.
  var os = require('os');
  var _origNetworkInterfaces = os.networkInterfaces;
  // Rate-limit the failure log. The bonjour watchdog inside ciao retries
  // advertising every few seconds, so a naive "log on every failure" fills
  // sandbox logs with hundreds of identical lines per hour. Log the first
  // failure (operator gets the actionable message) and at most one summary
  // every 5 minutes thereafter, with a suppression count so volume is
  // still observable. See GitHub issue #2611.
  var _failureCount = 0;
  var _lastLogMs = 0;
  var _suppressedSinceLog = 0;
  var _LOG_INTERVAL_MS = 5 * 60 * 1000;
  os.networkInterfaces = function () {
    try {
      return _origNetworkInterfaces.call(os);
    } catch (err) {
      _failureCount++;
      var nowMs = Date.now();
      var shouldLog = _failureCount === 1 || (nowMs - _lastLogMs) >= _LOG_INTERVAL_MS;
      if (shouldLog) {
        var suffix = _suppressedSinceLog > 0
          ? ' [' + _suppressedSinceLog + ' suppressed in last ~5min, ' + _failureCount + ' total]'
          : '';
        process.stderr.write(
          '[guard] os.networkInterfaces() failed: ' + (err.message || err) +
          ' — returning empty (mDNS disabled)' + suffix + '\n'
        );
        _lastLogMs = nowMs;
        _suppressedSinceLog = 0;
      } else {
        _suppressedSinceLog++;
      }
      return {};
    }
  };

  // Fallback: catch uncaughtException from ciao if the monkey-patch
  // doesn't cover all call sites. Gateway-only — registering ANY
  // uncaughtException listener tells Node "don't crash by default", and
  // we want CLI processes (agent, doctor, plugins, tui) to keep default
  // Node crash behavior so errors surface promptly.
  //
  // For gateway processes, non-ciao errors fall through (return) to the
  // sandbox safety net registered later in the preload chain. The safety
  // net is the single point of "keep gateway alive on unknown errors".
  if (_gatewayProcess) {
    process.on('uncaughtException', function (err, origin) {
      if (
        err && err.code === 'ERR_SYSTEM_ERROR' &&
        String(err.message || '').indexOf('uv_interface_addresses') !== -1
      ) {
        process.stderr.write(
          '[guard] ciao/networkInterfaces crash caught: ' + (err.message || err) +
          ' \u2014 gateway continues\n'
        );
        return;
      }
      if (err && err.stack && err.stack.indexOf('ciao') !== -1 &&
          String(err.message || '').indexOf('networkInterfaces') !== -1) {
        process.stderr.write(
          '[guard] ciao network error caught: ' + (err.message || err) +
          ' \u2014 gateway continues\n'
        );
        return;
      }
      // Not ciao — let the sandbox safety net handle it.
    });
  }
})();
