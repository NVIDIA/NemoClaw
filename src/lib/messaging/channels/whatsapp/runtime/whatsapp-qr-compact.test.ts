// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit coverage for the WhatsApp compact-QR preload's pure shape-detect and
// patch helpers (NemoClaw#4522 wrong-package-patch regression class). The live
// whatsapp-qr-compact E2E only asserts terminal row counts against the real
// upstream renderer; these tests pin the load-hook contract hermetically with
// fake module objects so no real qrcode / qrcode-terminal dependency is needed.

import { describe, expect, it, vi } from "vitest";

import {
  isQrcodePackage,
  isQrcodeTerminalPackage,
  patchQrcode,
  patchQrcodeTerminal,
} from "./whatsapp-qr-compact";
import { makeQrcodeLoadHook } from "./whatsapp-qr-compact-test-helpers";

// A fake of the `qrcode` package main: has its OWN toString + create().
function makeQrcodeFake() {
  const calls: Array<{ text: unknown; opts: unknown; cb: unknown }> = [];
  const mod = {
    calls,
    create() {
      return {};
    },
    toString(text: unknown, opts?: unknown, cb?: unknown) {
      calls.push({ text, opts, cb });
      return "QR";
    },
  };
  return mod;
}

// A fake of the `qrcode-terminal` package: has generate(), no create().
function makeQrcodeTerminalFake() {
  const calls: Array<{ text: unknown; opts: unknown; cb: unknown }> = [];
  const mod = {
    calls,
    generate(text: unknown, opts?: unknown, cb?: unknown) {
      calls.push({ text, opts, cb });
    },
  };
  return mod;
}

describe("isQrcodePackage (#4522)", () => {
  it("detects the qrcode package main by own toString + create", () => {
    expect(isQrcodePackage(makeQrcodeFake())).toBe(true);
  });

  it("does not match a lookalike submodule that only has create()", () => {
    // qrcode's internal lib/core/qrcode.js exposes create() but only the
    // inherited Object.prototype.toString — it must NOT be patched.
    const submodule = {
      create() {
        return {};
      },
    };
    expect(isQrcodePackage(submodule)).toBe(false);
  });

  it("does not match qrcode-terminal (has generate, no create)", () => {
    expect(isQrcodePackage(makeQrcodeTerminalFake())).toBe(false);
  });
});

describe("isQrcodeTerminalPackage (#4522)", () => {
  it("detects qrcode-terminal by own generate and absent create", () => {
    expect(isQrcodeTerminalPackage(makeQrcodeTerminalFake())).toBe(true);
  });

  it("does not match the qrcode package (has create)", () => {
    expect(isQrcodeTerminalPackage(makeQrcodeFake())).toBe(false);
  });
});

describe("patchQrcode (#4522)", () => {
  it("forces small:true only for terminal renders", () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    mod.toString("payload", { type: "terminal" });
    expect(mod.calls[0].opts).toEqual({ type: "terminal", small: true });
  });

  it.each(["svg", "png", "utf8"])("leaves type=%s options untouched", (type) => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    mod.toString("payload", { type });
    expect(mod.calls[0].opts).toEqual({ type });
    expect((mod.calls[0].opts as Record<string, unknown>).small).toBeUndefined();
  });

  it("does not mutate the caller-supplied options object", () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const opts = { type: "terminal" };
    mod.toString("payload", opts);
    expect(opts).toEqual({ type: "terminal" });
  });

  it("preserves the toString(text, cb) signature", () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const cb = vi.fn();
    mod.toString("payload", cb);
    expect(mod.calls[0].cb).toBe(cb);
    // No opts object was supplied, so nothing is forced.
    expect(mod.calls[0].opts).toEqual({});
  });

  it("is idempotent: double-patch does not re-wrap", () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const wrappedOnce = mod.toString;
    patchQrcode(mod);
    expect(mod.toString).toBe(wrappedOnce);
    // And forcing still works exactly once.
    mod.toString("payload", { type: "terminal" });
    expect(mod.calls[0].opts).toEqual({ type: "terminal", small: true });
  });
});

describe("patchQrcodeTerminal (#4522)", () => {
  it("forces small:true on generate", () => {
    const mod = makeQrcodeTerminalFake();
    patchQrcodeTerminal(mod);
    mod.generate("payload", {});
    expect(mod.calls[0].opts).toEqual({ small: true });
  });

  it("is idempotent: double-patch does not re-wrap", () => {
    const mod = makeQrcodeTerminalFake();
    patchQrcodeTerminal(mod);
    const wrappedOnce = mod.generate;
    patchQrcodeTerminal(mod);
    expect(mod.generate).toBe(wrappedOnce);
  });
});

describe("Module._load hook path-segment matching (#4522)", () => {
  it('patches import("qrcode")\'s resolved absolute path', async () => {
    // Simulate the real load hook: install a Module._load wrapper identical to
    // the runtime's, then require by an ABSOLUTE resolved path (as import()
    // bottoms out at) and confirm the returned module got the compact patch.
    const Module = (await import("node:module")).default as unknown as {
      _load: (...args: unknown[]) => unknown;
    };
    const qrcodeFake = makeQrcodeFake();
    const absolutePath = "/tmp/app/node_modules/qrcode/lib/index.js";
    const origLoad = Module._load;
    Module._load = makeQrcodeLoadHook(absolutePath, qrcodeFake);
    try {
      const loaded = Module._load(absolutePath) as ReturnType<typeof makeQrcodeFake>;
      expect(loaded).toBe(qrcodeFake);
      loaded.toString("payload", { type: "terminal" });
      expect(loaded.calls[0].opts).toEqual({ type: "terminal", small: true });
    } finally {
      Module._load = origLoad;
    }
  });
});
