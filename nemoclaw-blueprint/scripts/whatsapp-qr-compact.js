// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// whatsapp-qr-compact.js — force compact, scan-friendly QR rendering during
// in-sandbox WhatsApp pairing.
//
// The upstream @openclaw/whatsapp plugin renders the Linked-Devices pairing QR
// through the `qrcode-terminal` package at full size. Full-size rendering uses
// two terminal cells per QR module, so a WhatsApp Web QR fills 50–80+ rows and
// hundreds of columns — on a DGX Spark terminal it overflows the screen and is
// impossible to capture in a single phone-camera frame (NemoClaw#4522).
//
// NemoClaw owns the user-facing pairing workflow, so this preload forces the
// same `{ small: true }` half-block rendering the host-side WeChat QR path
// already uses (src/ext/wechat/login.ts). Half-block mode packs two QR rows
// into one terminal row and one module per column, roughly quartering the
// rendered area without changing the QR payload, so it still scans.
//
// The patch hooks Module._load rather than require('qrcode-terminal') directly
// because the package is resolved from the plugin's nested node_modules, which
// this preload (loaded from /tmp via NODE_OPTIONS) cannot resolve on its own.
// It only rewrites the `small` option; any caller that already opts into small
// rendering is unaffected, and the QR text/error-correction level is untouched.
//
// Removal criterion: drop this preload (and its wiring in nemoclaw-start.sh)
// once the bundled @openclaw/whatsapp renders a scan-friendly QR by default or
// exposes a documented compact-rendering flag NemoClaw can set through
// openclaw.json. Verify by pairing on a DGX Spark terminal and confirming the
// QR fits without this preload.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/4522

(function () {
  'use strict';

  if (process.__nemoclawWhatsappQrCompactInstalled) return;
  try {
    Object.defineProperty(process, '__nemoclawWhatsappQrCompactInstalled', { value: true });
  } catch (_e) {
    process.__nemoclawWhatsappQrCompactInstalled = true;
  }

  var Module = require('module');
  var origLoad = Module._load;

  function patchQrcodeTerminal(mod) {
    if (!mod || mod.__nemoclawCompactPatched) return mod;
    if (typeof mod.generate !== 'function') return mod;

    var origGenerate = mod.generate;
    mod.generate = function (text, opts, cb) {
      // Support both generate(text, cb) and generate(text, opts, cb).
      if (typeof opts === 'function') {
        cb = opts;
        opts = undefined;
      }
      var merged = {};
      if (opts && typeof opts === 'object') {
        for (var key in opts) {
          if (Object.prototype.hasOwnProperty.call(opts, key)) merged[key] = opts[key];
        }
      }
      merged.small = true;
      return origGenerate.call(this, text, merged, cb);
    };

    try {
      Object.defineProperty(mod, '__nemoclawCompactPatched', { value: true });
    } catch (_e) {
      mod.__nemoclawCompactPatched = true;
    }
    return mod;
  }

  Module._load = function (request, _parent, _isMain) {
    var loaded = origLoad.apply(this, arguments);
    if (request === 'qrcode-terminal') {
      try {
        return patchQrcodeTerminal(loaded);
      } catch (_e) {
        return loaded;
      }
    }
    return loaded;
  };
})();
