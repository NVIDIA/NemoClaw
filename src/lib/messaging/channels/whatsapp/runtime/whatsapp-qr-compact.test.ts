// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit coverage for the WhatsApp compact-QR preload's pure shape-detect and
// patch helpers (NemoClaw#4522 wrong-package-patch regression class). The live
// whatsapp-qr-compact E2E only asserts terminal row counts against the real
// upstream renderer; these tests pin the load-hook contract hermetically with
// fake module objects so no real qrcode / qrcode-terminal dependency is needed.

import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawQrTerminalLoadHook,
  describeOpenClawQrTerminalPatchSkip,
  isOpenClawQrTerminalRendererSource,
  isQrcodePackage,
  isQrcodeTerminalPackage,
  isReviewedOpenClawQrTerminalRendererIntegrity,
  patchOpenClawQrTerminalRendererSource,
  patchQrcode,
  patchQrcodeTerminal,
  REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256,
  registerOpenClawQrTerminalSourceLoader,
  warnWhatsappQrCompact,
} from "./whatsapp-qr-compact";
import { makeQrcodeLoadHook } from "./whatsapp-qr-compact-test-helpers";

const OPENCLAW_QR_RENDERER_SOURCE = `
const COMPACT_MARGIN_MODULES = 1;
function readModule(modules, x, y) {
  if (x < 0 || y < 0 || x >= modules.size || y >= modules.size) return false;
  return Boolean(modules.data[y * modules.size + x]);
}
function compactBlock(top, bottom) {
  if (top && bottom) return "█";
  if (top) return "▀";
  if (bottom) return "▄";
  return " ";
}
function renderCompactTerminalQr(modules) {
  const lines = [];
  for (let y = -1; y < modules.size + COMPACT_MARGIN_MODULES; y += 2) {
    let line = "";
    for (let x = -1; x < modules.size + COMPACT_MARGIN_MODULES; x += 1) line += compactBlock(readModule(modules, x, y), readModule(modules, x, y + 1));
    lines.push(line);
  }
  return lines.join("\\n");
}
async function renderQrTerminal(input, opts = {}) {
  const text = normalizeQrText(input);
  const qrCode = await loadQrCodeRuntime();
  if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text).modules);
  return await qrCode.toString(text, {
    small: false,
    type: "terminal"
  });
}
`;

// A fake of the `qrcode` package main: has its OWN toString + create().
function makeQrcodeFake() {
  const calls: Array<{ text: unknown; opts: unknown; cb: unknown }> = [];
  const createCalls: Array<{ text: unknown; opts: unknown }> = [];
  const mod = {
    calls,
    create(text: unknown, opts?: unknown) {
      createCalls.push({ text, opts });
      return { modules: { size: 1, data: [true] } };
    },
    createCalls,
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

describe("patchOpenClawQrTerminalRendererSource (#4522)", () => {
  it("detects the OpenClaw QR terminal renderer by the old patch selectors", () => {
    expect(isOpenClawQrTerminalRendererSource(OPENCLAW_QR_RENDERER_SOURCE)).toBe(true);
    expect(isOpenClawQrTerminalRendererSource("const unrelated = true;")).toBe(false);
  });

  it("recognizes the reviewed OpenClaw 2026.6.10 renderer integrity", () => {
    expect(
      isReviewedOpenClawQrTerminalRendererIntegrity(REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256),
    ).toBe(true);
    expect(isReviewedOpenClawQrTerminalRendererIntegrity("0".repeat(64))).toBe(false);
  });

  it("widens the compact-renderer quiet zone on all four edges", () => {
    const patched = patchOpenClawQrTerminalRendererSource(OPENCLAW_QR_RENDERER_SOURCE);

    expect(patched).toContain("const COMPACT_MARGIN_MODULES = 4;");
    expect(patched).toContain(
      "for (let y = -COMPACT_MARGIN_MODULES; y < modules.size + COMPACT_MARGIN_MODULES; y += 2)",
    );
    expect(patched).toContain(
      "for (let x = -COMPACT_MARGIN_MODULES; x < modules.size + COMPACT_MARGIN_MODULES; x += 1)",
    );
    expect(patched).not.toContain("toDataURL");
    expect(patched).not.toContain("data:image/png");
  });

  it("fails closed for an unreviewed renderer integrity", () => {
    expect(patchOpenClawQrTerminalRendererSource(OPENCLAW_QR_RENDERER_SOURCE, "0".repeat(64))).toBe(
      OPENCLAW_QR_RENDERER_SOURCE,
    );
    expect(
      describeOpenClawQrTerminalPatchSkip(OPENCLAW_QR_RENDERER_SOURCE, "0".repeat(64)),
    ).toContain("integrity is unreviewed");
  });

  it("fails closed instead of partially patching when a loop preimage drifts", () => {
    const drifted = OPENCLAW_QR_RENDERER_SOURCE.replace("let x = -1;", "let x = 0;");

    expect(patchOpenClawQrTerminalRendererSource(drifted)).toBe(drifted);
    expect(describeOpenClawQrTerminalPatchSkip(drifted)).toContain("preimage is unrecognized");
  });

  it("is idempotent once the source already has the four-edge quiet-zone patch", () => {
    const patched = patchOpenClawQrTerminalRendererSource(OPENCLAW_QR_RENDERER_SOURCE);

    expect(patchOpenClawQrTerminalRendererSource(patched)).toBe(patched);
  });

  it("passes unrelated module source through the synchronous load hook", () => {
    const load = createOpenClawQrTerminalLoadHook();
    const result = { format: "module", source: "const unrelated = true;" };

    expect(load("file:///tmp/unrelated.mjs", {}, () => result)).toBe(result);
  });

  it("passes unsupported non-text module source through without throwing", () => {
    const load = createOpenClawQrTerminalLoadHook();
    const result = { format: "module", source: {} };

    expect(load("file:///tmp/unsupported.mjs", {}, () => result)).toBe(result);
  });

  it("fails closed when the synchronous load hook sees an unreviewed renderer", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const load = createOpenClawQrTerminalLoadHook();
    const result = { format: "module", source: OPENCLAW_QR_RENDERER_SOURCE };
    try {
      expect(load("file:///tmp/openclaw-renderer.mjs", {}, () => result)).toBe(result);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("integrity is unreviewed"));
    } finally {
      write.mockRestore();
    }
  });

  it("rewrites a reviewed renderer through the synchronous load hook", () => {
    const load = createOpenClawQrTerminalLoadHook(
      () => REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256,
    );
    const result = { format: "module", source: Buffer.from(OPENCLAW_QR_RENDERER_SOURCE) };

    expect(load("file:///tmp/openclaw-renderer.mjs", {}, () => result)).toMatchObject({
      format: "module",
      source: expect.stringContaining("const COMPACT_MARGIN_MODULES = 4;"),
    });
  });

  it("rewrites reviewed Uint8Array and ArrayBuffer module sources", () => {
    const load = createOpenClawQrTerminalLoadHook(
      () => REVIEWED_OPENCLAW_QR_TERMINAL_RENDERER_SHA256,
    );
    const bytes = new TextEncoder().encode(OPENCLAW_QR_RENDERER_SOURCE);

    for (const source of [bytes, bytes.buffer]) {
      const result = { format: "module", source };
      expect(load("file:///tmp/openclaw-renderer.mjs", {}, () => result)).toMatchObject({
        format: "module",
        source: expect.stringContaining("const COMPACT_MARGIN_MODULES = 4;"),
      });
    }
  });

  it("registers a synchronous source hook for OpenClaw module loading (#6467)", () => {
    const registerHooks = vi.fn();
    const register = vi.fn();

    expect(registerOpenClawQrTerminalSourceLoader({ register, registerHooks })).toBe(true);
    expect(registerHooks).toHaveBeenCalledOnce();
    expect(registerHooks).toHaveBeenCalledWith({ load: expect.any(Function) });
    expect(register).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable and failed synchronous hook registration", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(registerOpenClawQrTerminalSourceLoader({})).toBe(false);
      expect(
        registerOpenClawQrTerminalSourceLoader({
          registerHooks() {
            throw new Error("registration failed");
          },
        }),
      ).toBe(false);
      expect(write).toHaveBeenNthCalledWith(1, expect.stringContaining("is unavailable"));
      expect(write).toHaveBeenNthCalledWith(2, expect.stringContaining("registration failed"));
    } finally {
      write.mockRestore();
    }
  });

  it("emits non-secret loader diagnostics when the source rewrite is skipped", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnWhatsappQrCompact(
        "OpenClaw QR renderer preimage is unrecognized; explicit compact quiet-zone rewrite skipped",
      );
      expect(write).toHaveBeenCalledWith(
        expect.stringContaining("[channels] WhatsApp compact-QR warning:"),
      );
      expect(write).toHaveBeenCalledWith(expect.not.stringContaining("data:image/png"));
    } finally {
      write.mockRestore();
    }
  });
});

describe("patchQrcode (#4522)", () => {
  it("renders terminal output through the four-edge compact renderer", async () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const rendered = await mod.toString("payload", { type: "terminal" });
    expect(rendered).toContain("\x1b[47m\x1b[30m");
    expect(mod.calls).toEqual([]);
    expect(mod.createCalls).toEqual([{ text: "payload", opts: {} }]);
  });

  it.each(["svg", "png", "utf8"])("leaves type=%s options untouched", (type) => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    mod.toString("payload", { type });
    expect(mod.calls[0].opts).toEqual({ type });
    expect((mod.calls[0].opts as Record<string, unknown>).small).toBeUndefined();
  });

  it("does not mutate the caller-supplied options object", async () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const opts = { type: "terminal" };
    await mod.toString("payload", opts);
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

  it("is idempotent: double-patch does not re-wrap", async () => {
    const mod = makeQrcodeFake();
    patchQrcode(mod);
    const wrappedOnce = mod.toString;
    patchQrcode(mod);
    expect(mod.toString).toBe(wrappedOnce);
    // And compact rendering still happens exactly once.
    await mod.toString("payload", { type: "terminal" });
    expect(mod.calls).toEqual([]);
    expect(mod.createCalls).toHaveLength(1);
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
      await loaded.toString("payload", { type: "terminal" });
      expect(loaded.calls).toEqual([]);
      expect(loaded.createCalls).toEqual([{ text: "payload", opts: {} }]);
    } finally {
      Module._load = origLoad;
    }
  });
});
