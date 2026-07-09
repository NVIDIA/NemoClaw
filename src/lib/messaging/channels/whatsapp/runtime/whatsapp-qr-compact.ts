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
//   * `qrcode` (has both `toString` and `create`): terminal renders are rebuilt
//     from `qrcode.create(...).modules` with a four-module quiet zone instead of
//     delegating to qrcode's built-in `small` terminal renderer. Non-terminal
//     renders (svg/png/utf8 data URIs) are left untouched.
//   * `qrcode-terminal` (has `generate`): force `small: true` as well, so the
//     fix also covers any agent/path that renders through that package.
//   * the reviewed OpenClaw QR renderer ES module: widen the compact-renderer
//     quiet zone on all four edges. This is hash-gated to the reviewed
//     OpenClaw 2026.6.10 renderer so a drifted upstream bundle fails closed.
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

function isOpenClawQrTerminalRendererSource(source) {
  return (
    typeof source === "string" &&
    source.indexOf("renderCompactTerminalQr") !== -1 &&
    source.indexOf("COMPACT_MARGIN_MODULES") !== -1 &&
    source.indexOf("async function renderQrTerminal") !== -1 &&
    source.indexOf("if (opts.small === true) return renderCompactTerminalQr") !== -1
  );
}

var REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256 =
  "f74865035a498389fe910b23537a7dffeaee1b05e044999d855b61c96af0ada7";

function isReviewedOpenClawQrTerminalRendererIntegrity(integrity: string | undefined) {
  return integrity === REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256;
}

function describeOpenClawQrTerminalPatchSkip(source: string, integrity?: string) {
  if (!isOpenClawQrTerminalRendererSource(source)) return "";
  if (
    integrity !== undefined &&
    integrity !== null &&
    !isReviewedOpenClawQrTerminalRendererIntegrity(integrity)
  ) {
    return "OpenClaw QR renderer integrity is unreviewed; explicit compact quiet-zone rewrite skipped";
  }

  var marginTo = "const COMPACT_MARGIN_MODULES = 4;";
  var yLoopTo =
    "for (let y = -COMPACT_MARGIN_MODULES; y < modules.size + COMPACT_MARGIN_MODULES; y += 2)";
  var xLoopTo =
    "for (let x = -COMPACT_MARGIN_MODULES; x < modules.size + COMPACT_MARGIN_MODULES; x += 1)";
  var alreadyPatched =
    source.indexOf(marginTo) !== -1 &&
    source.indexOf(yLoopTo) !== -1 &&
    source.indexOf(xLoopTo) !== -1;
  if (alreadyPatched) return "";

  var marginFrom = "const COMPACT_MARGIN_MODULES = 1;";
  var yLoopFrom = "for (let y = -1; y < modules.size + COMPACT_MARGIN_MODULES; y += 2)";
  var xLoopFrom = "for (let x = -1; x < modules.size + COMPACT_MARGIN_MODULES; x += 1)";
  var hasExactPreimage =
    source.indexOf(marginFrom) !== -1 &&
    source.indexOf(yLoopFrom) !== -1 &&
    source.indexOf(xLoopFrom) !== -1;
  if (!hasExactPreimage) {
    return "OpenClaw QR renderer preimage is unrecognized; explicit compact quiet-zone rewrite skipped";
  }
  return "";
}

function patchOpenClawQrTerminalRendererSource(source: string, integrity?: string) {
  if (!isOpenClawQrTerminalRendererSource(source)) return source;
  if (describeOpenClawQrTerminalPatchSkip(source, integrity)) return source;

  var marginFrom = "const COMPACT_MARGIN_MODULES = 1;";
  var marginTo = "const COMPACT_MARGIN_MODULES = 4;";
  var yLoopFrom = "for (let y = -1; y < modules.size + COMPACT_MARGIN_MODULES; y += 2)";
  var yLoopTo =
    "for (let y = -COMPACT_MARGIN_MODULES; y < modules.size + COMPACT_MARGIN_MODULES; y += 2)";
  var xLoopFrom = "for (let x = -1; x < modules.size + COMPACT_MARGIN_MODULES; x += 1)";
  var xLoopTo =
    "for (let x = -COMPACT_MARGIN_MODULES; x < modules.size + COMPACT_MARGIN_MODULES; x += 1)";

  var alreadyPatched =
    source.indexOf(marginTo) !== -1 &&
    source.indexOf(yLoopTo) !== -1 &&
    source.indexOf(xLoopTo) !== -1;
  if (alreadyPatched) return source;

  var hasExactPreimage =
    source.indexOf(marginFrom) !== -1 &&
    source.indexOf(yLoopFrom) !== -1 &&
    source.indexOf(xLoopFrom) !== -1;
  if (!hasExactPreimage) return source;

  return source
    .replace(marginFrom, marginTo)
    .replace(yLoopFrom, yLoopTo)
    .replace(xLoopFrom, xLoopTo);
}

function decodeOpenClawQrTerminalSource(source) {
  if (typeof source === "string") return source;
  if (typeof Buffer !== "undefined") {
    if (Buffer.isBuffer(source)) return source.toString("utf8");
    if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
    if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
  }
  return null;
}

function createOpenClawQrTerminalLoadHook(sha256Hex?) {
  if (typeof sha256Hex !== "function") {
    var createHash = require("node:crypto").createHash;
    sha256Hex = function (source) {
      return createHash("sha256").update(source).digest("hex");
    };
  }
  return function load(url, context, nextLoad) {
    var result = nextLoad(url, context);
    if (!result || result.format !== "module") return result;
    var source = decodeOpenClawQrTerminalSource(result.source);
    if (source === null || !isOpenClawQrTerminalRendererSource(source)) return result;
    var integrity = sha256Hex(source);
    var skipReason = describeOpenClawQrTerminalPatchSkip(source, integrity);
    if (skipReason) {
      warnWhatsappQrCompact(skipReason);
      return result;
    }
    var patched = patchOpenClawQrTerminalRendererSource(source, integrity);
    if (patched === source) return result;
    return { ...result, source: patched };
  };
}

function warnWhatsappQrCompact(message) {
  try {
    process.stderr.write("[channels] WhatsApp compact-QR warning: " + message + "\n");
  } catch (_e) {
    // Best effort diagnostic only.
  }
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

var NEMOCLAW_COMPACT_MARGIN_MODULES = 4;
var TERMINAL_BLACK_ON_WHITE = "\x1b[47m\x1b[30m";
var TERMINAL_RESET = "\x1b[0m";
var FULL_BLOCK = "█";
var UPPER_HALF_BLOCK = "▀";
var LOWER_HALF_BLOCK = "▄";

function readQrModule(modules, x, y) {
  if (x < 0 || y < 0 || x >= modules.size || y >= modules.size) {
    return false;
  }
  return Boolean(modules.data[y * modules.size + x]);
}

function compactQrBlock(top, bottom) {
  if (top && bottom) return FULL_BLOCK;
  if (top) return UPPER_HALF_BLOCK;
  if (bottom) return LOWER_HALF_BLOCK;
  return " ";
}

function renderWhatsappCompactTerminalQr(modules) {
  var lines = [];
  for (
    var y = -NEMOCLAW_COMPACT_MARGIN_MODULES;
    y < modules.size + NEMOCLAW_COMPACT_MARGIN_MODULES;
    y += 2
  ) {
    var line = TERMINAL_BLACK_ON_WHITE;
    for (
      var x = -NEMOCLAW_COMPACT_MARGIN_MODULES;
      x < modules.size + NEMOCLAW_COMPACT_MARGIN_MODULES;
      x += 1
    ) {
      line += compactQrBlock(readQrModule(modules, x, y), readQrModule(modules, x, y + 1));
    }
    lines.push(line + TERMINAL_RESET);
  }
  return lines.join("\n");
}

function cloneQrcodeCreateOptions(opts) {
  var createOpts = {};
  for (var key in opts) {
    if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
    if (key === "type" || key === "small") continue;
    createOpts[key] = opts[key];
  }
  return createOpts;
}

function renderQrcodePackageTerminal(mod, text, opts) {
  return renderWhatsappCompactTerminalQr(mod.create(text, cloneQrcodeCreateOptions(opts)).modules);
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
    if (merged.type === "terminal") {
      if (typeof cb === "function") {
        try {
          cb(null, renderQrcodePackageTerminal(mod, text, merged));
        } catch (err) {
          cb(err);
        }
        return undefined;
      }
      return Promise.resolve().then(function () {
        return renderQrcodePackageTerminal(mod, text, merged);
      });
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

// Pure routing decision shared by the installed hook and its tests. Only a
// request string that mentions qrcode is eligible; the shape-detect guards then
// decide which patch (if any) applies. Keeping the request filter ahead of the
// patch calls means a non-qrcode request never mutates `loaded` as a side
// effect. A patch failure degrades to the unpatched module.
function resolvePatchedModule(request, loaded) {
  if (typeof request === "string" && request.indexOf("qrcode") !== -1) {
    try {
      if (isQrcodePackage(loaded)) return patchQrcode(loaded);
      if (isQrcodeTerminalPackage(loaded)) return patchQrcodeTerminal(loaded);
    } catch (_e) {
      return loaded;
    }
  }
  return loaded;
}

// Named exports so the pure shape-detect + patch helpers can be unit-tested
// (NemoClaw#4522 regression class) without pulling in a real qrcode dependency.
// The auto-install below still uses the exact same functions, so the runtime
// hook behaves identically.
export {
  createOpenClawQrTerminalLoadHook,
  describeOpenClawQrTerminalPatchSkip,
  hasOwn,
  isOpenClawQrTerminalRendererSource,
  isQrcodePackage,
  isQrcodeTerminalPackage,
  isReviewedOpenClawQrTerminalRendererIntegrity,
  patchOpenClawQrTerminalRendererSource,
  patchQrcode,
  patchQrcodeTerminal,
  REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256,
  registerOpenClawQrTerminalSourceLoader,
  renderQrcodePackageTerminal,
  renderWhatsappCompactTerminalQr,
  resolvePatchedModule,
  warnWhatsappQrCompact,
};

function registerOpenClawQrTerminalSourceLoader(Module) {
  // Keep this in the same synchronous hook chain as the Slack preload. Mixing
  // Module.register()'s async loader with registerHooks() breaks OpenClaw's
  // synchronous module loads because the async loader has no loadSync (#6467).
  if (!Module || typeof Module.registerHooks !== "function") {
    warnWhatsappQrCompact(
      "OpenClaw QR renderer source loader registration is unavailable; explicit compact quiet-zone rewrite skipped",
    );
    return false;
  }

  try {
    Module.registerHooks({ load: createOpenClawQrTerminalLoadHook() });
    return true;
  } catch (_e) {
    warnWhatsappQrCompact(
      "OpenClaw QR renderer source loader registration failed; explicit compact quiet-zone rewrite skipped",
    );
    return false;
  }
}

function installOpenClawQrTerminalSourceLoader(Module) {
  if (process.__nemoclawWhatsappQrCompactSourceLoaderInstalled) return;
  if (!registerOpenClawQrTerminalSourceLoader(Module)) return;
  try {
    Object.defineProperty(process, "__nemoclawWhatsappQrCompactSourceLoaderInstalled", {
      value: true,
    });
  } catch (_e) {
    process.__nemoclawWhatsappQrCompactSourceLoaderInstalled = true;
  }
}

// Install the Module._load hook that patches qrcode / qrcode-terminal on load.
// Guarded so double-require is a no-op. Runs on import (the file is loaded via
// `--require`/preload), preserving the previous self-installing IIFE behavior.
function installWhatsappQrCompactHook() {
  if (process.__nemoclawWhatsappQrCompactInstalled) return;
  try {
    Object.defineProperty(process, "__nemoclawWhatsappQrCompactInstalled", { value: true });
  } catch (_e) {
    process.__nemoclawWhatsappQrCompactInstalled = true;
  }

  var Module = require("module");
  installOpenClawQrTerminalSourceLoader(Module);
  var origLoad = Module._load;

  Module._load = function (request, _parent, _isMain) {
    var loaded = origLoad.apply(this, arguments);
    // Cheap path filter + shape-detect routing. `import("qrcode")` arrives here
    // as the resolved absolute path (…/qrcode/lib/index.js), so the filter in
    // resolvePatchedModule matches on the path segment too, not just the bare
    // specifier.
    return resolvePatchedModule(request, loaded);
  };
}

installWhatsappQrCompactHook();
