// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "nemoclaw-start.sh");
const PRELOAD_SOURCE = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "messaging",
  "channels",
  "whatsapp",
  "runtime",
  "whatsapp-qr-compact.ts",
);

// The WhatsApp pairing QR is rendered by the `qrcode` package (bundled inside
// `openclaw`), NOT `qrcode-terminal`. The plugin's onQr callback calls
// renderQrTerminal() → qrcode.toString(text, { type: "terminal", small }) and
// the bundled @openclaw/whatsapp passes NO `small`, so it defaults to full
// size. These tests prove the preload patches that real package shape. End-to-
// end proof that this shrinks a *real* rendered QR lives in
// test/e2e-scenario/live/whatsapp-qr-compact.test.ts, which drives the actual
// upstream renderer at the version bundled in Dockerfile.base. Ref: NemoClaw#4522.

// A fake `qrcode` package (toString + create — the shape the preload keys on)
// and a fake `qrcode-terminal` (generate). Each records the options it was
// called with so we can assert exactly what the preload forwarded, without
// depending on a real renderer or on network installs.
function writeFakeModules(root: string): void {
  const qrcodeDir = path.join(root, "node_modules", "qrcode");
  fs.mkdirSync(qrcodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(qrcodeDir, "package.json"),
    JSON.stringify({ name: "qrcode", version: "0.0.0-fake", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(qrcodeDir, "index.js"),
    [
      "const calls = [];",
      "module.exports = {",
      "  // qrcode's real signatures: toString(text, [opts], [cb]).",
      "  toString(text, opts, cb) {",
      "    if (typeof opts === 'function') { cb = opts; opts = undefined; }",
      "    calls.push(opts || {});",
      "    const out = JSON.stringify(opts || {});",
      "    if (typeof cb === 'function') return cb(null, out);",
      "    return Promise.resolve(out);",
      "  },",
      "  // Presence of create() is how the preload distinguishes qrcode from",
      "  // qrcode-terminal; it never calls through to it here.",
      "  create() { return { modules: { size: 0 } }; },",
      "  __calls: calls,",
      "};",
    ].join("\n"),
  );

  const termDir = path.join(root, "node_modules", "qrcode-terminal");
  fs.mkdirSync(termDir, { recursive: true });
  fs.writeFileSync(
    path.join(termDir, "package.json"),
    JSON.stringify({ name: "qrcode-terminal", version: "0.0.0-fake", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(termDir, "index.js"),
    [
      "const calls = [];",
      "module.exports = {",
      "  generate(text, opts, cb) {",
      "    if (typeof opts === 'function') { cb = opts; opts = undefined; }",
      "    calls.push(opts || {});",
      "    if (typeof cb === 'function') return cb('rendered');",
      "  },",
      "  setErrorLevel() {},",
      "  __calls: calls,",
      "};",
    ].join("\n"),
  );
}

// Run a probe script under a temp project that has the fake modules installed,
// with the preload loaded via --require. Returns the parsed JSON the probe
// prints to stdout.
function runProbe(probe: string, opts: { withPreload?: boolean } = {}): any {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-qr-unit-"));
  try {
    writeFakeModules(tempDir);
    const probePath = path.join(tempDir, "probe.mjs");
    fs.writeFileSync(probePath, probe);
    const args = opts.withPreload ? ["--require", PRELOAD_SOURCE, probePath] : [probePath];
    const r = spawnSync(process.execPath, args, {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`probe failed (status=${r.status}): ${r.stderr}`);
    }
    return JSON.parse(r.stdout.trim());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Exercise the real require + dynamic-import entry points the OpenClaw renderer
// uses, capturing the options each toString/generate call actually received.
const QRCODE_PROBE = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const result = {};

// 1) Dynamic import — exactly how openclaw's renderQrTerminal loads qrcode.
const dyn = (await import("qrcode")).default ?? (await import("qrcode"));
await dyn.toString("payload", { type: "terminal" });           // login default
await dyn.toString("payload", { type: "terminal", small: false }); // explicit big
await dyn.toString("payload", { type: "terminal", small: true });  // already small
await dyn.toString("payload", { type: "svg" });                // non-terminal
await dyn.toString("payload");                                 // no opts at all
result.qrcode = dyn.__calls;

// 2) CommonJS require — same module object, same patch.
const cjs = require("qrcode");
result.qrcodeRequireIsPatched = cjs.__calls === dyn.__calls;

// 3) qrcode-terminal fallback path (for any agent that renders through it).
const term = require("qrcode-terminal");
term.generate("payload", { small: false }, () => {});
term.generate("payload", () => {});
result.qrcodeTerminal = term.__calls;

process.stdout.write(JSON.stringify(result));
`;

describe("WhatsApp compact-QR preload (qrcode package)", () => {
  const baseline = runProbe(QRCODE_PROBE, { withPreload: false });
  const patched = runProbe(QRCODE_PROBE, { withPreload: true });

  it("baseline leaves the qrcode terminal render at full size", () => {
    // Sanity check the fixture: without the preload, a terminal render with no
    // `small` (the reporter's path) is NOT forced small.
    expect(baseline.qrcode[0]).toEqual({ type: "terminal" });
    expect(baseline.qrcode[0].small).toBeUndefined();
  });

  it("forces small:true on a terminal render with no small option", () => {
    expect(patched.qrcode[0]).toEqual({ type: "terminal", small: true });
  });

  it("overrides an explicit small:false terminal render back to compact", () => {
    expect(patched.qrcode[1]).toEqual({ type: "terminal", small: true });
  });

  it("leaves an already-compact terminal render unchanged", () => {
    expect(patched.qrcode[2]).toEqual({ type: "terminal", small: true });
  });

  it("does NOT touch non-terminal renders (svg/png/utf8 data URIs)", () => {
    // svg render — small must not be injected; other channels/flows rely on it.
    expect(patched.qrcode[3]).toEqual({ type: "svg" });
    expect(patched.qrcode[3].small).toBeUndefined();
  });

  it("does NOT inject small when no type is given (defaults to non-terminal)", () => {
    expect(patched.qrcode[4]).toEqual({});
  });

  it("patches the same module object for require() and dynamic import()", () => {
    expect(patched.qrcodeRequireIsPatched).toBe(true);
  });

  it("also forces small:true on the qrcode-terminal generate() fallback", () => {
    expect(patched.qrcodeTerminal[0]).toEqual({ small: true });
    expect(patched.qrcodeTerminal[1]).toEqual({ small: true });
  });

  it("is idempotent when the preload is required twice", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-qr-unit-twice-"));
    try {
      writeFakeModules(tempDir);
      const probePath = path.join(tempDir, "probe.mjs");
      fs.writeFileSync(probePath, QRCODE_PROBE);
      const r = spawnSync(
        process.execPath,
        ["--require", PRELOAD_SOURCE, "--require", PRELOAD_SOURCE, probePath],
        { cwd: tempDir, encoding: "utf-8", timeout: 10000 },
      );
      expect(r.status).toBe(0);
      const twice = JSON.parse(r.stdout.trim());
      expect(twice.qrcode[0]).toEqual({ type: "terminal", small: true });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// The connect-session NODE_OPTIONS wiring (and the openclaw() guard injection)
// is exercised behaviorally rather than by asserting on source text: the guard
// describe-block below executes the extracted openclaw() function and checks the
// --require injection, and the end-to-end renderer E2E
// (test/e2e-scenario/live/whatsapp-qr-compact.test.ts) plus the in-sandbox
// M-WA6d check in test-messaging-providers.sh prove the wired preload actually
// shrinks the QR.

// Extract the sandbox-side `openclaw()` guard function from the single-quoted
// heredoc so we can exercise the WhatsApp login branch without a live sandbox.
function extractGuardFunction(src: string): string {
  const begin = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end");
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Expected nemoclaw-configure-guard markers in scripts/nemoclaw-start.sh");
  }
  return src.slice(begin, end);
}

describe("WhatsApp pairing guard (channels login --channel whatsapp)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const guard = extractGuardFunction(src);

  function runGuard(
    args: string[],
    opts: { gatewayUrl?: string; preloadPresent?: boolean; fakeExit?: number },
  ): { status: number; stdout: string; stderr: string; preloadPath: string } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-guard-"));
    try {
      // Fake `openclaw` binary on PATH so `command openclaw` resolves to it.
      const binDir = path.join(tempDir, "bin");
      fs.mkdirSync(binDir);
      const fakeOpenclaw = path.join(binDir, "openclaw");
      fs.writeFileSync(
        fakeOpenclaw,
        [
          "#!/usr/bin/env bash",
          'echo "FAKE_OPENCLAW_ARGS=$*"',
          'echo "FAKE_OPENCLAW_NODE_OPTIONS=${NODE_OPTIONS:-}"',
          `exit ${opts.fakeExit ?? 0}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      const preloadPath = path.join(tempDir, "nemoclaw-whatsapp-qr-compact.js");
      if (opts.preloadPresent) fs.writeFileSync(preloadPath, "// stub preload\n");
      const connectPreloadsPath = path.join(tempDir, "nemoclaw-messaging-connect-preloads.list");
      if (opts.preloadPresent) fs.writeFileSync(connectPreloadsPath, `${preloadPath}\n`);

      // The guard body hardcodes literal /tmp paths (single-quoted heredoc);
      // redirect them to temp files for the test.
      const guardBody = guard
        .replaceAll("/tmp/nemoclaw-whatsapp-qr-compact.js", preloadPath)
        .replaceAll("/tmp/nemoclaw-messaging-connect-preloads.list", connectPreloadsPath);

      const wrapperLines = [
        "#!/usr/bin/env bash",
        `export PATH=${JSON.stringify(binDir)}:\"$PATH\"`,
      ];
      if (opts.gatewayUrl !== undefined) {
        wrapperLines.push(`export OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.gatewayUrl)}`);
      } else {
        wrapperLines.push("unset OPENCLAW_GATEWAY_URL");
      }
      wrapperLines.push(
        guardBody,
        `openclaw ${args.map((a) => JSON.stringify(a)).join(" ")}`,
        'echo "GUARD_EXIT=$?"',
      );
      const wrapperPath = path.join(tempDir, "run.sh");
      fs.writeFileSync(wrapperPath, wrapperLines.join("\n"), { mode: 0o700 });

      const r = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 10000 });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        preloadPath,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("blocks login for non-WhatsApp channels", () => {
    const r = runGuard(["channels", "login", "--channel", "telegram"], {
      gatewayUrl: "ws://127.0.0.1:8080",
    });
    expect(r.stderr).toContain("only supported inside the sandbox for WhatsApp");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
  });

  it("refuses to pair when OPENCLAW_GATEWAY_URL is missing", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      preloadPresent: true,
    });
    expect(r.stderr).toContain("OPENCLAW_GATEWAY_URL is not set");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    // Must not attempt the login when the gateway env is missing.
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
  });

  it.each([
    "foo",
    "http://127.0.0.1:18789",
    "127.0.0.1:18789",
  ])("refuses to pair when OPENCLAW_GATEWAY_URL is not a ws:// URL (%s)", (badUrl) => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: badUrl,
      preloadPresent: true,
    });
    expect(r.stderr).toContain("is not a ws:// gateway URL");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
  });

  it.each([
    "ws://127.0.0.1:18789",
    "wss://gateway.internal:443",
  ])("accepts ws:// and wss:// gateway URLs (%s)", (goodUrl) => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: goodUrl,
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("injects the compact-QR preload into NODE_OPTIONS for the login", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).toContain(`--require ${r.preloadPath}`);
    expect(r.stdout).toContain("GUARD_EXIT=0");
    // Clean exit: no gateway-close diagnostics.
    expect(r.stderr).not.toContain("abnormal closure");
  });

  it("runs login even if the preload file is absent (older base image)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      preloadPresent: false,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).not.toContain("--require");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("surfaces gateway-close diagnostics separately from the QR on non-zero exit", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      preloadPresent: true,
      fakeExit: 7,
    });
    expect(r.stderr).toContain("1008 abnormal closure");
    expect(r.stderr).toContain("not a QR-size issue");
    // Guard preserves the underlying exit code.
    expect(r.stdout).toContain("GUARD_EXIT=7");
  });
});
