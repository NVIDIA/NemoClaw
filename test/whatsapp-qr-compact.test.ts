// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "nemoclaw-start.sh");
const PRELOAD_SOURCE = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "scripts",
  "whatsapp-qr-compact.js",
);

// A WhatsApp Web pairing ref is a long, dense payload. Use a deterministic one
// so the rendered dimensions are stable across runs.
const WHATSAPP_QR_PAYLOAD =
  "2@" +
  Buffer.from("ref-token-".repeat(8)).toString("base64") +
  "," +
  Buffer.from("noise-key-".repeat(4)).toString("base64") +
  "," +
  Buffer.from("identity-key").toString("base64") +
  ",abcdEFGH1234";

// Render the QR via the cb form (so the rendered string is captured rather
// than written to stdout) and report its dimensions for several option shapes.
const PROBE_PROGRAM = `
const qr = require("qrcode-terminal");
const payload = ${JSON.stringify(WHATSAPP_QR_PAYLOAD)};
function dims(call) {
  let out = "";
  call((s) => { out = s; });
  const lines = out.split("\\n");
  return { lines: lines.length, cols: Math.max(...lines.map((l) => [...l].length)) };
}
const result = {
  // generate(text, cb) — no opts at all.
  noOpts: dims((cb) => qr.generate(payload, cb)),
  // generate(text, { small: false }, cb) — caller explicitly asks for big.
  explicitBig: dims((cb) => qr.generate(payload, { small: false }, cb)),
  // generate(text, { small: true }, cb) — caller already compact.
  explicitSmall: dims((cb) => qr.generate(payload, { small: true }, cb)),
};
process.stdout.write(JSON.stringify(result));
`;

function runProbe(withPreload: boolean): {
  noOpts: { lines: number; cols: number };
  explicitBig: { lines: number; cols: number };
  explicitSmall: { lines: number; cols: number };
} {
  const args = withPreload ? ["--require", PRELOAD_SOURCE, "-e", PROBE_PROGRAM] : ["-e", PROBE_PROGRAM];
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 10000,
  });
  if (r.status !== 0) {
    throw new Error(`probe failed (status=${r.status}): ${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim());
}

describe("WhatsApp compact-QR preload", () => {
  const baseline = runProbe(false);
  const patched = runProbe(true);

  it("baseline qrcode-terminal renders large QR without options", () => {
    // Sanity check the fixture: the default (non-small) rendering is the
    // oversized output the issue is about, and small mode is meaningfully
    // shorter and narrower.
    expect(baseline.noOpts.lines).toBeGreaterThan(baseline.explicitSmall.lines);
    expect(baseline.noOpts.cols).toBeGreaterThan(baseline.explicitSmall.cols);
  });

  it("forces compact rendering when the caller passes no options", () => {
    // With the preload, generate(text, cb) must match an explicit small render
    // and be strictly smaller than the unpatched default.
    expect(patched.noOpts).toEqual(baseline.explicitSmall);
    expect(patched.noOpts.lines).toBeLessThan(baseline.noOpts.lines);
  });

  it("overrides an explicit small:false back to compact rendering", () => {
    expect(patched.explicitBig).toEqual(baseline.explicitSmall);
  });

  it("leaves an already-compact caller unchanged", () => {
    expect(patched.explicitSmall).toEqual(baseline.explicitSmall);
  });

  it("keeps the rendered QR within a scan-friendly bound (<= 40 lines)", () => {
    // The reporter saw 80+ lines. Compact rendering must stay well under a
    // single phone-camera frame. 40 lines is a generous ceiling for a
    // half-block WhatsApp QR.
    expect(patched.noOpts.lines).toBeLessThanOrEqual(40);
  });

  it("is idempotent when loaded twice", () => {
    const r = spawnSync(
      process.execPath,
      ["--require", PRELOAD_SOURCE, "--require", PRELOAD_SOURCE, "-e", PROBE_PROGRAM],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 10000 },
    );
    expect(r.status).toBe(0);
    const twice = JSON.parse(r.stdout.trim());
    expect(twice.noOpts).toEqual(baseline.explicitSmall);
  });
});

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

      // The guard body hardcodes the literal /tmp path (single-quoted heredoc);
      // redirect it to the temp file for the test.
      const guardBody = guard.replaceAll("/tmp/nemoclaw-whatsapp-qr-compact.js", preloadPath);

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

  it.each(["foo", "http://127.0.0.1:18789", "127.0.0.1:18789"])(
    "refuses to pair when OPENCLAW_GATEWAY_URL is not a ws:// URL (%s)",
    (badUrl) => {
      const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
        gatewayUrl: badUrl,
        preloadPresent: true,
      });
      expect(r.stderr).toContain("is not a ws:// gateway URL");
      expect(r.stdout).toContain("GUARD_EXIT=1");
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
    },
  );

  it.each(["ws://127.0.0.1:18789", "wss://gateway.internal:443"])(
    "accepts ws:// and wss:// gateway URLs (%s)",
    (goodUrl) => {
      const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
        gatewayUrl: goodUrl,
        preloadPresent: true,
      });
      expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
      expect(r.stdout).toContain("GUARD_EXIT=0");
    },
  );

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
