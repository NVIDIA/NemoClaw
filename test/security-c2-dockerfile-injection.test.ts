// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: C-2 — CHAT_UI_URL source injection in Dockerfile.
//
// The vulnerable pattern interpolates Docker build-args directly into a
// generated source string. A single-quote in the value closes the JavaScript
// string literal and allows arbitrary code execution at image build time.
//
// The fixed pattern reads values via process.env (data, not source code).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");

function runNode(src: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("node", ["-e", src], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

// Simulate what Docker ARG substitution produces (the VULNERABLE pattern)
function vulnerableSource(chatUiUrlValue: string): string {
  return (
    `const chatUiUrl = '${chatUiUrlValue}'; ` +
    "console.log(JSON.stringify(chatUiUrl))"
  );
}

// Simulate the FIXED pattern (env var, no source interpolation)
function fixedSource(): string {
  return (
    "const chatUiUrl = process.env.CHAT_UI_URL; " +
    "console.log(JSON.stringify(chatUiUrl))"
  );
}

// ═══════════════════════════════════════════════════════════════════
// 1. PoC — vulnerable pattern allows code injection
// ═══════════════════════════════════════════════════════════════════
describe("C-2 PoC: vulnerable pattern (ARG interpolation into source)", () => {
  it("benign URL works in the vulnerable pattern (baseline)", () => {
    const src = vulnerableSource("http://127.0.0.1:18789");
    const result = runNode(src);
    expect(result.status).toBe(0);
    expect(result.stdout.includes("127.0.0.1")).toBeTruthy();
  });

  it("single-quote in URL causes SyntaxError", () => {
    const src = vulnerableSource("http://x'.evil.com");
    const result = runNode(src);
    expect(result.status).not.toBe(0);
    expect(result.stderr.includes("SyntaxError")).toBeTruthy();
  });

  it("injection payload writes canary file — arbitrary JavaScript executes", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-poc-${Date.now()}`);
    try {
      const payload = `http://x'; require('node:fs').writeFileSync('${canary}','PWNED') //`;
      const src = vulnerableSource(payload);
      runNode(src);

      expect(fs.existsSync(canary)).toBeTruthy();
      expect(fs.readFileSync(canary, "utf-8")).toBe("PWNED");
    } finally {
      try {
        fs.unlinkSync(canary);
      } catch {
        /* cleanup */
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Fix verification — env var pattern treats all payloads as data
// ═══════════════════════════════════════════════════════════════════
describe("C-2 fix: env var pattern (process.env) is safe", () => {
  it("benign URL works through env var", () => {
    const result = runNode(fixedSource(), { CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(result.status).toBe(0);
    expect(result.stdout.includes("127.0.0.1")).toBeTruthy();
  });

  it("single-quote in URL is treated as data, not a code boundary", () => {
    const result = runNode(fixedSource(), { CHAT_UI_URL: "http://x'.evil.com" });
    expect(result.status).toBe(0);
    expect(result.stdout.includes("x'.evil.com")).toBeTruthy();
  });

  it("injection payload does NOT execute — URL is inert data", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-fixed-${Date.now()}`);
    try {
      const payload = `http://x'; require('node:fs').writeFileSync('${canary}','PWNED') //`;
      const result = runNode(fixedSource(), { CHAT_UI_URL: payload });

      expect(result.status).toBe(0);
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      try {
        fs.unlinkSync(canary);
      } catch {
        /* cleanup */
      }
    }
  });

  it("semicolons and require calls in URL are literal data", () => {
    const dangerous = "http://x; require('node:child_process').execSync('id')";
    const result = runNode(fixedSource(), { CHAT_UI_URL: dangerous });
    // The URL is treated as data. The key property is that no injected
    // JavaScript executes.
    const combined = result.stdout + result.stderr;
    expect(!combined.includes("uid=")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Gateway auth hardening — no hardcoded insecure defaults (#117)
// ═══════════════════════════════════════════════════════════════════
describe("Gateway auth hardening: Dockerfile must not hardcode insecure auth defaults", () => {
  it("NEMOCLAW_DISABLE_DEVICE_AUTH is promoted to ENV before the config generator RUN layer", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let promoted = false;
    let inEnvBlock = false;
    let sawGeneratorRun = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*FROM\b/.test(line)) {
        promoted = false;
        inEnvBlock = false;
      }
      if (/^\s*ENV\b/.test(line)) {
        inEnvBlock = true;
      }
      if (inEnvBlock && /NEMOCLAW_DISABLE_DEVICE_AUTH[=\s]/.test(line)) {
        promoted = true;
      }
      if (inEnvBlock && !/\\\s*$/.test(line)) {
        inEnvBlock = false;
      }
      if (
        /^\s*RUN\b.*node\s+--experimental-strip-types\s+\/usr\/local\/lib\/nemoclaw\/generate-openclaw-config\.mts\b/.test(
          line,
        )
      ) {
        expect(promoted).toBeTruthy();
        return;
      }
    }
    expect(sawGeneratorRun).toBeTruthy();
  });
});
