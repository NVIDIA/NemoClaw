// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: C-2 — CHAT_UI_URL Python code injection in Dockerfile.
//
// The vulnerable pattern interpolates Docker build-args directly into a
// python3 -c source string. A single-quote in the value closes the Python
// string literal and allows arbitrary code execution at image build time.
//
// The fixed pattern reads values via os.environ (data, not source code).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");

function runPython(src: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("python3", ["-c", src], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

// Simulate what Docker ARG substitution produces (the VULNERABLE pattern)
function vulnerableSource(chatUiUrlValue: string): string {
  return (
    "import json, os, secrets; " +
    "from urllib.parse import urlparse; " +
    `chat_ui_url = '${chatUiUrlValue}'; ` +
    "parsed = urlparse(chat_ui_url); " +
    "print(repr(chat_ui_url))"
  );
}

// Simulate the FIXED pattern (env var, no source interpolation)
function fixedSource(): string {
  return (
    "import json, os, secrets; " +
    "from urllib.parse import urlparse; " +
    "chat_ui_url = os.environ['CHAT_UI_URL']; " +
    "parsed = urlparse(chat_ui_url); " +
    "print(repr(chat_ui_url))"
  );
}

// ═══════════════════════════════════════════════════════════════════
// 1. PoC — vulnerable pattern allows code injection
// ═══════════════════════════════════════════════════════════════════
describe("C-2 PoC: vulnerable pattern (ARG interpolation into python3 -c)", () => {
  it("benign URL works in the vulnerable pattern (baseline)", () => {
    const src = vulnerableSource("http://127.0.0.1:18789");
    const result = runPython(src);
    expect(result.status).toBe(0);
    expect(result.stdout.includes("127.0.0.1")).toBeTruthy();
  });

  it("single-quote in URL causes SyntaxError", () => {
    const src = vulnerableSource("http://x'.evil.com");
    const result = runPython(src);
    expect(result.status).not.toBe(0);
    expect(result.stderr.includes("SyntaxError")).toBeTruthy();
  });

  it("injection payload writes canary file — arbitrary Python executes", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-poc-${Date.now()}`);
    try {
      const payload = `http://x'; open('${canary}','w').write('PWNED') #`;
      const src = vulnerableSource(payload);
      runPython(src);

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
describe("C-2 fix: env var pattern (os.environ) is safe", () => {
  it("benign URL works through env var", () => {
    const result = runPython(fixedSource(), { CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(result.status).toBe(0);
    expect(result.stdout.includes("127.0.0.1")).toBeTruthy();
  });

  it("single-quote in URL is treated as data, not a code boundary", () => {
    const result = runPython(fixedSource(), { CHAT_UI_URL: "http://x'.evil.com" });
    expect(result.status).toBe(0);
    expect(result.stdout.includes("x'.evil.com")).toBeTruthy();
  });

  it("injection payload does NOT execute — URL is inert data", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-fixed-${Date.now()}`);
    try {
      const payload = `http://x'; open('${canary}','w').write('PWNED') #`;
      const result = runPython(fixedSource(), { CHAT_UI_URL: payload });

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

  it("semicolons and import statements in URL are literal data", () => {
    const dangerous = "http://x; import subprocess; subprocess.run(['id'])";
    const result = runPython(fixedSource(), { CHAT_UI_URL: dangerous });
    // The URL is treated as data — urlparse may or may not raise, but
    // the key property is that no code injection occurs. Check stdout or stderr
    // does NOT contain evidence of os.system/subprocess execution.
    const combined = result.stdout + result.stderr;
    expect(!combined.includes("uid=")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Dockerfile regression guard — source must use the fixed pattern
// ═══════════════════════════════════════════════════════════════════
describe("C-2 regression: Dockerfile must not interpolate build-args into Python source", () => {
  it("Dockerfile does not interpolate CHAT_UI_URL into a Python string literal", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const vulnerablePattern = /\$(?:\{CHAT_UI_URL\}|CHAT_UI_URL\b)/;
    const lines = src.split("\n");
    let inPythonRunBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        inPythonRunBlock = true;
      }
      if (inPythonRunBlock && vulnerablePattern.test(line)) {
        expect.unreachable(
          `Dockerfile:${i + 1} interpolates CHAT_UI_URL into a Python string literal.\n` +
            `  Line: ${line.trim()}\n` +
            `  Fix: use os.environ['CHAT_UI_URL'] instead.`,
        );
      }
      if (inPythonRunBlock && !/\\\s*$/.test(line)) {
        inPythonRunBlock = false;
      }
    }
  });

  it("Dockerfile does not interpolate NEMOCLAW_MODEL into a Python string literal", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const vulnerablePattern = /\$(?:\{NEMOCLAW_MODEL\}|NEMOCLAW_MODEL\b)/;
    const lines = src.split("\n");
    let inPythonRunBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        inPythonRunBlock = true;
      }
      if (inPythonRunBlock && vulnerablePattern.test(line)) {
        expect.unreachable(
          `Dockerfile:${i + 1} interpolates NEMOCLAW_MODEL into a Python string literal.\n` +
            `  Line: ${line.trim()}\n` +
            `  Fix: use os.environ['NEMOCLAW_MODEL'] instead.`,
        );
      }
      if (inPythonRunBlock && !/\\\s*$/.test(line)) {
        inPythonRunBlock = false;
      }
    }
  });

  it("Dockerfile promotes CHAT_UI_URL to ENV before the RUN layer", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let chatUiUrlPromoted = false;
    let inEnvBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset on new build stage — ENV must be in the same stage as the RUN layer
      if (/^\s*FROM\b/.test(line)) {
        chatUiUrlPromoted = false;
        inEnvBlock = false;
      }
      // Detect start of an ENV instruction
      if (/^\s*ENV\b/.test(line)) {
        inEnvBlock = true;
      }
      // Check if CHAT_UI_URL is set in the current ENV block (same line or continuation)
      if (inEnvBlock && /CHAT_UI_URL[=\s]/.test(line)) {
        chatUiUrlPromoted = true;
      }
      // ENV block ends when the line does NOT end with a backslash continuation
      if (inEnvBlock && !/\\\s*$/.test(line)) {
        inEnvBlock = false;
      }
      // Verify promotion happened before the config-generation RUN layer
      if (
        /^\s*RUN\b.*python3\s+\/usr\/local\/lib\/nemoclaw\/generate-openclaw-config\.py\b/.test(
          line,
        )
      ) {
        expect(chatUiUrlPromoted).toBeTruthy();
        return; // Found the RUN layer and verified — done
      }
    }
    expect(chatUiUrlPromoted).toBeTruthy();
  });

  it("Python config script uses os.environ to read CHAT_UI_URL", () => {
    // Config generation is now in an external script, not inline python3 -c.
    // Verify the Dockerfile references the script and the script reads the env var.
    const dockerSrc = fs.readFileSync(DOCKERFILE, "utf-8");
    expect(dockerSrc).toMatch(/COPY.*generate-openclaw-config\.py/);
    expect(dockerSrc).toMatch(/RUN python3 \/usr\/local\/lib\/nemoclaw\/generate-openclaw-config\.py/);

    const scriptPath = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.py");
    const scriptSrc = fs.readFileSync(scriptPath, "utf-8");
    expect(scriptSrc).toMatch(/CHAT_UI_URL/);
    expect(scriptSrc).toMatch(/os\.environ/);
  });

  it("Dockerfile promotes NEMOCLAW_MODEL to ENV before the RUN layer", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let nemoModelPromoted = false;
    let inEnvBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset on new build stage — ENV must be in the same stage as the RUN layer
      if (/^\s*FROM\b/.test(line)) {
        nemoModelPromoted = false;
        inEnvBlock = false;
      }
      // Detect start of an ENV instruction
      if (/^\s*ENV\b/.test(line)) {
        inEnvBlock = true;
      }
      // Check if NEMOCLAW_MODEL is set in the current ENV block (same line or continuation)
      if (inEnvBlock && /NEMOCLAW_MODEL[=\s]/.test(line)) {
        nemoModelPromoted = true;
      }
      // ENV block ends when the line does NOT end with a backslash continuation
      if (inEnvBlock && !/\\\s*$/.test(line)) {
        inEnvBlock = false;
      }
      // Verify promotion happened before the config-generation RUN layer
      if (
        /^\s*RUN\b.*python3\s+\/usr\/local\/lib\/nemoclaw\/generate-openclaw-config\.py\b/.test(
          line,
        )
      ) {
        expect(nemoModelPromoted).toBeTruthy();
        return; // Found the RUN layer and verified — done
      }
    }
    expect(nemoModelPromoted).toBeTruthy();
  });

  it("Python config script uses os.environ to read NEMOCLAW_MODEL", () => {
    // Config generation is now in an external script, not inline python3 -c.
    const scriptPath = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.py");
    const scriptSrc = fs.readFileSync(scriptPath, "utf-8");
    expect(scriptSrc).toMatch(/NEMOCLAW_MODEL/);
    expect(scriptSrc).toMatch(/os\.environ/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Gateway auth hardening — no hardcoded insecure defaults (#117)
// ═══════════════════════════════════════════════════════════════════
describe("Gateway auth hardening: Dockerfile must not hardcode insecure auth defaults", () => {
  it("dangerouslyDisableDeviceAuth is not hardcoded to True", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    // Must not contain a literal `'dangerouslyDisableDeviceAuth': True`
    expect(src).not.toMatch(/'dangerouslyDisableDeviceAuth':\s*True/);
  });

  it("allowInsecureAuth is not hardcoded to True", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    // Must not contain a literal `'allowInsecureAuth': True`
    expect(src).not.toMatch(/'allowInsecureAuth':\s*True/);
  });

  it("dangerouslyDisableDeviceAuth is derived from env var AND non-loopback URL", () => {
    // Config generation moved to external script — check the script source
    const scriptPath = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.py");
    const src = fs.readFileSync(scriptPath, "utf-8");
    // Env var check still present
    expect(src).toMatch(/NEMOCLAW_DISABLE_DEVICE_AUTH/);
    // Non-loopback derivation present
    expect(src).toMatch(/is_loopback/);
    // Both feed into disable_device_auth
    expect(src).toMatch(/disable_device_auth/);
    expect(src).toMatch(/dangerouslyDisableDeviceAuth/);
  });

  it("allowInsecureAuth is derived from URL scheme (explicit http allowlist)", () => {
    // Config generation moved to external script — check the script source
    const scriptPath = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.py");
    const src = fs.readFileSync(scriptPath, "utf-8");
    // Must use explicit 'http' allowlist — not `!= 'https'` which would allow
    // insecure auth for malformed or unknown schemes (CodeRabbit review on #123)
    expect(src).toMatch(/allow_insecure\s*=\s*parsed\.scheme\s*==\s*['"]http['"]/);
    expect(src).not.toMatch(/allow_insecure\s*=\s*parsed\.scheme\s*!=\s*['"]https['"]/);
    // And use the derived variable in the config dict
    expect(src).toMatch(/allowInsecureAuth/);
    expect(src).toMatch(/allow_insecure/);
  });

  it("NEMOCLAW_DISABLE_DEVICE_AUTH defaults to '0' (secure by default)", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    expect(src).toMatch(/ARG\s+NEMOCLAW_DISABLE_DEVICE_AUTH=0/);
  });

  it("NEMOCLAW_DISABLE_DEVICE_AUTH is promoted to ENV before the Python RUN layer", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let promoted = false;
    let inEnvBlock = false;
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
        /^\s*RUN\b.*python3\s+\/usr\/local\/lib\/nemoclaw\/generate-openclaw-config\.py\b/.test(
          line,
        )
      ) {
        expect(promoted).toBeTruthy();
        return;
      }
    }
    expect(promoted).toBeTruthy();
  });
});
