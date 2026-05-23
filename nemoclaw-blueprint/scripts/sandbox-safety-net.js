// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// sandbox-safety-net.js — last-resort handler that keeps the gateway alive
// when any library throws an uncaught exception or unhandled rejection.
//
// Contract:
//
//   1. Inside the OpenShell sandbox the gateway is shared infrastructure.
//      User-initiated actions (loading a plugin, starting a sidecar,
//      running an agent against the gateway) must not be able to take it
//      down. Node.js 22+ defaults --unhandled-rejections=throw which
//      crashes on the first stray rejection from any library — including
//      libraries we don't control.
//
//   2. Specific known-benign patterns are documented inline below. They
//      get a single-line summary and are absorbed silently. Each pattern
//      MUST document which library produces it, why it's safe to absorb
//      in the sandbox context, and what the upstream fix is. Prefer
//      disabling/configuring the upstream component so the rejection
//      never fires; this list is the safety net, not the policy.
//
//   3. Unknown errors do NOT crash the gateway either, but they are
//      logged with full stack so they can be diagnosed and either fixed
//      upstream or added to the allow-list with explicit justification.
//      "Unknown means crash" is the wrong default for shared
//      infrastructure; "unknown means log loudly" is the right default.
//
//   4. No process.exit interception. An earlier iteration intercepted
//      process.exit during swallow windows, which masked legitimate
//      shutdown signals and was itself the kind of catch-all hack we
//      want to avoid.
//
//   5. Only active when OPENSHELL_SANDBOX=1 (set by OpenShell at runtime),
//      and only for gateway processes. The gateway can appear as the
//      launcher (`openclaw gateway run ...`) or the re-execed
//      `openclaw-gateway` child. CLI commands (agent, doctor, plugins,
//      tui, etc.) get default Node behavior so errors surface promptly
//      to users running short-lived tools.

(function () {
  'use strict';
  if (process.env.OPENSHELL_SANDBOX !== '1') return;

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
  if (!_gatewayProcess) return;

  try {
    process.stderr.write('[sandbox-safety-net] loaded (' + _gatewayProcess + ')\n');
  } catch (_) {}

  // KNOWN-BENIGN ERROR PATTERNS
  //
  // ciao / @homebridge/ciao — mDNS service-discovery library used by the
  // OpenClaw bonjour plugin (introduced in 2026.4.15). Sandboxes have
  // restricted network namespaces with no multicast. Two failure modes:
  //   - sync: os.networkInterfaces() throws ERR_SYSTEM_ERROR
  //     uv_interface_addresses. Pre-empted by ciao-network-guard.js,
  //     which monkey-patches os.networkInterfaces() to return {}.
  //   - async: the probe state machine cancels itself during gateway
  //     startup/reload and emits "CIAO PROBING CANCELLED" as an unhandled
  //     rejection. This is the path we catch here.
  // Upstream fix: bonjour is disabled via plugins.entries.bonjour.enabled
  // = false in the sandbox openclaw.json. This pattern is a backstop in
  // case the disable is bypassed or a future release introduces another
  // mDNS code path.
  function classifyBenignRejection(reason) {
    if (!reason) return null;
    var msg = String((reason && reason.message) || reason);
    var stack = (reason && reason.stack) || '';

    if (msg.indexOf('CIAO') !== -1 ||
        stack.indexOf('@homebridge/ciao') !== -1 ||
        stack.indexOf('/ciao/') !== -1) {
      return 'ciao/mDNS (sandbox lacks multicast; bonjour should be disabled in openclaw.json)';
    }
    if (reason && reason.code === 'ERR_SYSTEM_ERROR' &&
        msg.indexOf('uv_interface_addresses') !== -1) {
      return 'uv_interface_addresses (restricted netns)';
    }
    return null;
  }

  process.on('uncaughtException', function (err, origin) {
    // Sync error paths are pre-empted by the targeted guards
    // (ciao-network-guard.js, slack-channel-guard.js when Slack is
    // configured). If we get here it's an error those guards didn't
    // recognize. Log full stack and stay alive — registering this
    // listener is what tells Node "don't crash on uncaughtException".
    try {
      process.stderr.write(
        '[sandbox-safety-net] uncaughtException [unhandled by upstream guards \u2014 please diagnose]: ' +
        ((err && err.stack) ? err.stack : String(err)) +
        ' (origin: ' + origin + ') \u2014 gateway continues\n'
      );
    } catch (_) {}
  });

  process.on('unhandledRejection', function (reason, promise) {
    var benign = classifyBenignRejection(reason);
    if (benign) {
      try {
        process.stderr.write(
          '[sandbox-safety-net] unhandledRejection [known-benign: ' + benign + ']: ' +
          ((reason && reason.message) ? reason.message : String(reason)) + '\n'
        );
      } catch (_) {}
      return;
    }
    try {
      process.stderr.write(
        '[sandbox-safety-net] unhandledRejection [UNKNOWN PATTERN \u2014 please diagnose]: ' +
        ((reason && reason.stack) ? reason.stack : String(reason)) +
        ' \u2014 gateway continues\n'
      );
    } catch (_) {}
  });
})();
