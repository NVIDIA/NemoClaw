// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
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
// size. These tests prove the preload intercepts that real package shape and
// renders via qrcode.create() with a four-module quiet zone. End-to-
// end proof that this shrinks a *real* rendered QR lives in
// test/e2e/live/whatsapp-qr-compact.test.ts, which drives the actual
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
      "const createCalls = [];",
      "const dataUrlCalls = [];",
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
      "  // qrcode-terminal. The preload uses it for patched terminal renders.",
      "  create(text, opts) {",
      "    createCalls.push(opts || {});",
      "    return { modules: { size: 2, data: [true, false, false, true] } };",
      "  },",
      "  toDataURL(text) {",
      "    dataUrlCalls.push(text);",
      "    return Promise.resolve(`data:image/png;base64,STUB(${text})`);",
      "  },",
      "  __calls: calls,",
      "  __createCalls: createCalls,",
      "  __dataUrlCalls: dataUrlCalls,",
      "};",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(root, "openclaw-qr-terminal.mjs"),
    [
      'const qrCodeRuntimeLoader = { load: async () => (await import("qrcode")).default ?? (await import("qrcode")) };',
      "async function loadQrCodeRuntime() {",
      "  return await qrCodeRuntimeLoader.load();",
      "}",
      "function normalizeQrText(text) {",
      "  if (typeof text !== 'string') throw new TypeError('QR text must be a string.');",
      "  return text;",
      "}",
      "const COMPACT_MARGIN_MODULES = 1;",
      "function renderCompactTerminalQr(modules) {",
      "  return `compact-margin:${COMPACT_MARGIN_MODULES}:size:${modules.size}`;",
      "}",
      "async function renderQrTerminal(input, opts = {}) {",
      "  const text = normalizeQrText(input);",
      "  const qrCode = await loadQrCodeRuntime();",
      "  if (opts.small === true) return renderCompactTerminalQr(qrCode.create(text).modules);",
      "  return await qrCode.toString(text, {",
      "    small: false,",
      "    type: 'terminal'",
      "  });",
      "}",
      "export { renderQrTerminal };",
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
result.qrcodeCreate = dyn.__createCalls;

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

const OPENCLAW_QR_RENDERER_PROBE = `
const result = {};
const renderer = await import("./openclaw-qr-terminal.mjs");
result.compact = await renderer.renderQrTerminal("payload", { small: true });
const dyn = (await import("qrcode")).default ?? (await import("qrcode"));
result.qrcodeCreate = dyn.__createCalls;
result.qrcodeDataUrl = dyn.__dataUrlCalls;
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

  it("renders terminal output through qrcode.create instead of qrcode.toString small mode", () => {
    expect(patched.qrcodeCreate).toEqual([{}, {}, {}]);
    expect(patched.qrcode).toEqual([{ type: "svg" }, {}]);
  });

  it("keeps explicit small:false terminal renders on the custom compact path", () => {
    expect(patched.qrcodeCreate[1]).toEqual({});
  });

  it("keeps already-compact terminal renders on the custom compact path", () => {
    expect(patched.qrcodeCreate[2]).toEqual({});
  });

  it("does NOT touch non-terminal renders (svg/png/utf8 data URIs)", () => {
    // svg render — small must not be injected; other channels/flows rely on it.
    expect(patched.qrcode[0]).toEqual({ type: "svg" });
    expect(patched.qrcode[0].small).toBeUndefined();
  });

  it("does NOT inject small when no type is given (defaults to non-terminal)", () => {
    expect(patched.qrcode[1]).toEqual({});
  });

  it("patches the same module object for require() and dynamic import()", () => {
    expect(patched.qrcodeRequireIsPatched).toBe(true);
  });

  it("also forces small:true on the qrcode-terminal generate() fallback", () => {
    expect(patched.qrcodeTerminal[0]).toEqual({ small: true });
    expect(patched.qrcodeTerminal[1]).toEqual({ small: true });
  });

  it("does not source-patch an unreviewed OpenClaw-looking renderer", () => {
    const baselineRenderer = runProbe(OPENCLAW_QR_RENDERER_PROBE, { withPreload: false });
    const patchedRenderer = runProbe(OPENCLAW_QR_RENDERER_PROBE, { withPreload: true });

    expect(baselineRenderer.compact).toBe("compact-margin:1:size:2");
    expect(baselineRenderer.qrcodeDataUrl).toEqual([]);
    expect(patchedRenderer.compact).toBe("compact-margin:1:size:2");
    expect(patchedRenderer.compact).not.toContain("data:image/png");
    expect(patchedRenderer.qrcodeDataUrl).toEqual([]);
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
      expect(twice.qrcodeCreate).toEqual([{}, {}, {}]);
      expect(twice.qrcode).toEqual([{ type: "svg" }, {}]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// The connect-session NODE_OPTIONS wiring (and the openclaw() guard injection)
// is exercised behaviorally rather than by asserting on source text: the guard
// describe-block below executes the extracted openclaw() function and checks the
// --require injection, and the end-to-end renderer E2E
// (test/e2e/live/whatsapp-qr-compact.test.ts) plus the
// messaging-providers Vitest coverage prove the wired preload actually shrinks
// the QR.

// Extract the sandbox-side `openclaw()` guard function from the single-quoted
// heredoc so we can exercise the WhatsApp login branch without a live sandbox.
function extractGuardFunction(src: string, trustedGatewayUrl: string): string {
  const begin = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end");
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error("Expected nemoclaw-configure-guard markers in scripts/nemoclaw-start.sh");
  }
  const guardSource = src.slice(begin, end);
  const injectionStartMarker =
    "GUARDENVEOF\n    # nemoclaw-trusted-gateway-literal-injection begin";
  const injectionEndMarker =
    "    # nemoclaw-trusted-gateway-literal-injection end\n    cat <<'GUARDENVEOF'\n";
  const injectionStart = guardSource.indexOf(injectionStartMarker);
  const injectionEnd = guardSource.indexOf(injectionEndMarker, injectionStart);
  assert(
    injectionStart !== -1 && injectionEnd !== -1,
    "Expected the generated trusted gateway literal injection markers",
  );
  return `${guardSource.slice(0, injectionStart)}            _nemoclaw_whatsapp_trusted_url=${JSON.stringify(trustedGatewayUrl)}\n${guardSource.slice(injectionEnd + injectionEndMarker.length)}`;
}

describe("WhatsApp pairing guard (channels login --channel whatsapp)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function runGuard(
    args: string[],
    opts: {
      gatewayUrl?: string;
      insecurePublicWs?: string;
      privateGatewayUrl?: string;
      insecurePrivateWs?: string;
      preloadPresent?: boolean;
      fakeExit?: number;
    },
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
          'echo "FAKE_OPENCLAW_GATEWAY_URL=${OPENCLAW_GATEWAY_URL:-unset}"',
          'echo "FAKE_OPENCLAW_INSECURE_WS=${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-unset}"',
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
      const guardBody = extractGuardFunction(src, opts.privateGatewayUrl ?? "")
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
        opts.insecurePublicWs !== undefined
          ? `export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=${JSON.stringify(opts.insecurePublicWs)}`
          : "unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
        opts.privateGatewayUrl !== undefined
          ? `export NEMOCLAW_OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.privateGatewayUrl)}`
          : "unset NEMOCLAW_OPENCLAW_GATEWAY_URL",
        opts.insecurePrivateWs !== undefined
          ? `export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=${JSON.stringify(opts.insecurePrivateWs)}`
          : "unset NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
      );
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

  it("refuses to pair when no public or private gateway URL is available (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      preloadPresent: true,
    });
    expect(r.stderr).toContain("gateway URL is not set");
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
    expect(r.stdout).toContain(`FAKE_OPENCLAW_GATEWAY_URL=${goodUrl}`);
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("reinjects the NemoClaw-private gateway URL and private-WS flag for WhatsApp (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=ws://10.200.0.2:18790");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=1");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("preserves an explicit public gateway override without borrowing the private opt-in (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "wss://explicit.example.test:443",
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=wss://explicit.example.test:443");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=unset");
  });

  it("preserves the insecure-WS marker explicitly coupled to a public override (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://explicit.example.test:18790",
      insecurePublicWs: "explicit-marker",
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=ws://explicit.example.test:18790");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=explicit-marker");
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
    expect(r.stdout).not.toContain(r.preloadPath);
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
