// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// whatsapp-qr-compact.ts — force compact, scan-friendly QR rendering during
// in-sandbox WhatsApp pairing.
//
// THE BUG (NemoClaw#4522): a WhatsApp Web Linked-Devices pairing payload is a
// long, dense string, so its QR needs ~53 modules per side. Rendered at full
// size — two terminal cells per module — it spans ~56 rows and ~110 columns
// and overflows a DGX Spark terminal, so it cannot be captured in a single
// phone-camera frame. Half-block ("small") rendering packs two QR rows into
// one terminal row and one cell per column, roughly quartering the area to
// ~29 rows / ~55 columns without changing the payload, so it still scans.
//
// THE ACTUAL RENDER PATH (and why the previous fix missed it): the
// `openclaw channels login --channel whatsapp` flow renders the pairing QR
// through `renderQrTerminal()` in `openclaw/plugin-sdk/media-runtime`, which
// calls the **`qrcode`** package: `qrcode.toString(text, { type: "terminal",
// small })`. Crucially, the pinned @openclaw/whatsapp (version-matched to the
// bundled OpenClaw, e.g. 2026.5.22) calls `renderQrTerminal(qr)` with NO
// `small` option, so it defaults to `small: false` and renders full size.
// The previous NemoClaw fix patched the unrelated `qrcode-terminal` package,
// which the WhatsApp plugin never loads — so it never affected the QR. This
// preload patches the package that actually renders the QR.
//
// WHAT THIS DOES: it hooks Module._load (CJS require AND the CJS-interop path
// that `import("qrcode")` bottoms out at) and wraps the loaded module:
//   * `qrcode` (has both `toString` and `create`): force `small: true` for
//     terminal renders. Non-terminal renders (svg/png/utf8 data URIs) are
//     left untouched, and a caller that already opts into `small` is a no-op.
//   * `qrcode-terminal` (has `generate`): force `small: true` as well, so the
//     fix also covers any agent/path that renders through that package.
// The QR text and error-correction level are never altered — only the
// terminal cell packing — so the rendered code is identical apart from size.
//
// The hook matches by module API shape (not just the request string) because
// `import("qrcode")` resolves the bare specifier to an absolute path before it
// reaches Module._load, so a `request === "qrcode"` check alone would miss it.
//
// Removal criterion: drop this preload (and its wiring in nemoclaw-start.sh)
// once every bundled @openclaw/whatsapp version renders a scan-friendly QR by
// default. Verify by pairing on a DGX Spark terminal and confirming the QR
// fits without this preload.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/4522

(function () {
  "use strict";

  if (process.__nemoclawWhatsappQrCompactInstalled) return;
  try {
    Object.defineProperty(process, "__nemoclawWhatsappQrCompactInstalled", { value: true });
  } catch (_e) {
    process.__nemoclawWhatsappQrCompactInstalled = true;
  }

  var Module = require("module");
  var origLoad = Module._load;

  function markPatched(mod) {
    try {
      Object.defineProperty(mod, "__nemoclawCompactPatched", { value: true });
    } catch (_e) {
      mod.__nemoclawCompactPatched = true;
    }
  }

  function hasOwn(mod, name) {
    return mod && Object.prototype.hasOwnProperty.call(mod, name);
  }

  // `qrcode` package main: renderQrTerminal() calls qrcode.toString(text, opts).
  // Require an OWN toString (every object inherits Object.prototype.toString, so
  // a plain `typeof mod.toString` check would also match qrcode's internal
  // submodules — e.g. lib/core/qrcode.js, which exposes create() but only the
  // inherited toString — and needlessly mutate them). The package main exposes
  // its own toString + create; the submodules do not have an own toString.
  function isQrcodePackage(mod) {
    return (
      hasOwn(mod, "toString") &&
      typeof mod.toString === "function" &&
      typeof mod.create === "function"
    );
  }

  // `qrcode-terminal` package: exposes its own generate(text, opts, cb) and,
  // unlike `qrcode`, has no create().
  function isQrcodeTerminalPackage(mod) {
    return (
      hasOwn(mod, "generate") &&
      typeof mod.generate === "function" &&
      typeof mod.create !== "function"
    );
  }

  function patchQrcode(mod) {
    if (mod.__nemoclawCompactPatched) return mod;
    var origToString = mod.toString;
    mod.toString = function (text, opts, cb) {
      // Support toString(text, cb) and toString(text, opts, cb) / (text, opts).
      if (typeof opts === "function") {
        cb = opts;
        opts = undefined;
      }
      var merged = {};
      if (opts && typeof opts === "object") {
        for (var key in opts) {
          if (Object.prototype.hasOwnProperty.call(opts, key)) merged[key] = opts[key];
        }
      }
      // Only the terminal renderer has the oversize problem. `type` defaults
      // to "utf8" in the qrcode package, but the WhatsApp path always passes
      // "terminal" explicitly; force small there and leave every other type
      // (svg/png/utf8 data URIs used elsewhere) exactly as the caller asked.
      if (merged.type === "terminal") {
        merged.small = true;
      }
      return origToString.call(this, text, merged, cb);
    };
    markPatched(mod);
    return mod;
  }

  function patchQrcodeTerminal(mod) {
    if (mod.__nemoclawCompactPatched) return mod;
    var origGenerate = mod.generate;
    mod.generate = function (text, opts, cb) {
      if (typeof opts === "function") {
        cb = opts;
        opts = undefined;
      }
      var merged = {};
      if (opts && typeof opts === "object") {
        for (var key in opts) {
          if (Object.prototype.hasOwnProperty.call(opts, key)) merged[key] = opts[key];
        }
      }
      merged.small = true;
      return origGenerate.call(this, text, merged, cb);
    };
    markPatched(mod);
    return mod;
  }

  Module._load = function (request, _parent, _isMain) {
    var loaded = origLoad.apply(this, arguments);
    // Cheap path filter: only inspect modules whose request mentions qrcode.
    // `import("qrcode")` arrives here as the resolved absolute path
    // (…/qrcode/lib/index.js), so match on the path segment too, not just the
    // bare specifier.
    if (typeof request === "string" && request.indexOf("qrcode") !== -1) {
      try {
        if (isQrcodePackage(loaded)) return patchQrcode(loaded);
        if (isQrcodeTerminalPackage(loaded)) return patchQrcodeTerminal(loaded);
      } catch (_e) {
        return loaded;
      }
    }
    return loaded;
  };
})();
