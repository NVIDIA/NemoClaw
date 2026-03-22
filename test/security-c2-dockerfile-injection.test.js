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

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DOCKERFILE = path.join(__dirname, "..", "Dockerfile");

function runPython(src, env = {}) {
  return spawnSync("python3", ["-c", src], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

// Simulate what Docker ARG substitution produces (the VULNERABLE pattern)
function vulnerableSource(chatUiUrlValue) {
  return (
    "import json, os, secrets; " +
    "from urllib.parse import urlparse; " +
    `chat_ui_url = '${chatUiUrlValue}'; ` +
    "parsed = urlparse(chat_ui_url); " +
    "print(repr(chat_ui_url))"
  );
}

// Simulate the FIXED pattern (env var, no source interpolation)
function fixedSource() {
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
    assert.equal(result.status, 0, `python3 exit ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.includes("127.0.0.1"));
  });

  it("single-quote in URL causes SyntaxError", () => {
    const src = vulnerableSource("http://x'.evil.com");
    const result = runPython(src);
    assert.notEqual(result.status, 0, "Expected non-zero exit (SyntaxError)");
    assert.ok(result.stderr.includes("SyntaxError"));
  });

  it("injection payload writes canary file — arbitrary Python executes", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-poc-${Date.now()}`);
    try {
      const payload = `http://x'; open('${canary}','w').write('PWNED') #`;
      const src = vulnerableSource(payload);
      runPython(src);

      assert.ok(
        fs.existsSync(canary),
        "Canary file must exist — injection payload executed arbitrary Python",
      );
      assert.equal(fs.readFileSync(canary, "utf-8"), "PWNED");
    } finally {
      try { fs.unlinkSync(canary); } catch { /* cleanup */ }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Fix verification — env var pattern treats all payloads as data
// ═══════════════════════════════════════════════════════════════════
describe("C-2 fix: env var pattern (os.environ) is safe", () => {
  it("benign URL works through env var", () => {
    const result = runPython(fixedSource(), { CHAT_UI_URL: "http://127.0.0.1:18789" });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("127.0.0.1"));
  });

  it("single-quote in URL is treated as data, not a code boundary", () => {
    const result = runPython(fixedSource(), { CHAT_UI_URL: "http://x'.evil.com" });
    assert.equal(result.status, 0, `Expected exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes("x'.evil.com"));
  });

  it("injection payload does NOT execute — URL is inert data", () => {
    const canary = path.join(os.tmpdir(), `nemoclaw-c2-fixed-${Date.now()}`);
    try {
      const payload = `http://x'; open('${canary}','w').write('PWNED') #`;
      const result = runPython(fixedSource(), { CHAT_UI_URL: payload });

      assert.equal(result.status, 0);
      assert.equal(
        fs.existsSync(canary),
        false,
        "Canary file must NOT exist — injection payload must not execute",
      );
    } finally {
      try { fs.unlinkSync(canary); } catch { /* cleanup */ }
    }
  });

  it("semicolons and import statements in URL are literal data", () => {
    const dangerous = "http://x; import subprocess; subprocess.run(['id'])";
    const result = runPython(fixedSource(), { CHAT_UI_URL: dangerous });
    // The URL is treated as data — urlparse may or may not raise, but
    // the key property is that no code injection occurs. Check stdout or stderr
    // does NOT contain evidence of os.system/subprocess execution.
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes("uid="),
      "No command execution output should appear — URL is inert data",
    );
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
        assert.fail(
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
        assert.fail(
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
      // Verify promotion happened before the python3 -c RUN layer
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        assert.ok(
          chatUiUrlPromoted,
          `Dockerfile:${i + 1} has a python3 -c RUN layer but CHAT_UI_URL was not promoted via ENV before it`,
        );
        return; // Found the RUN layer and verified — done
      }
    }
    assert.ok(
      chatUiUrlPromoted,
      "Dockerfile must have ENV instruction that promotes CHAT_UI_URL from ARG to env var before the python3 -c RUN layer",
    );
  });

  it("Python script uses os.environ to read CHAT_UI_URL", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let inPythonRunBlock = false;
    let hasEnvRead = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        inPythonRunBlock = true;
      }
      if (inPythonRunBlock) {
        if (
          line.includes("os.environ['CHAT_UI_URL']") ||
          line.includes('os.environ["CHAT_UI_URL"]') ||
          line.includes("os.environ.get('CHAT_UI_URL'") ||
          line.includes('os.environ.get("CHAT_UI_URL"')
        ) {
          hasEnvRead = true;
        }
      }
      if (inPythonRunBlock && !/\\\s*$/.test(line)) {
        inPythonRunBlock = false;
      }
    }
    assert.ok(hasEnvRead, "Python script in the python3 -c RUN block must read CHAT_UI_URL via os.environ");
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
      // Verify promotion happened before the python3 -c RUN layer
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        assert.ok(
          nemoModelPromoted,
          `Dockerfile:${i + 1} has a python3 -c RUN layer but NEMOCLAW_MODEL was not promoted via ENV before it`,
        );
        return; // Found the RUN layer and verified — done
      }
    }
    assert.ok(
      nemoModelPromoted,
      "Dockerfile must have ENV instruction that promotes NEMOCLAW_MODEL from ARG to env var before the python3 -c RUN layer",
    );
  });

  it("Python script uses os.environ to read NEMOCLAW_MODEL", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    const lines = src.split("\n");
    let inPythonRunBlock = false;
    let hasEnvRead = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*RUN\b.*python3\s+-c\b/.test(line)) {
        inPythonRunBlock = true;
      }
      if (inPythonRunBlock) {
        if (
          line.includes("os.environ['NEMOCLAW_MODEL']") ||
          line.includes('os.environ["NEMOCLAW_MODEL"]') ||
          line.includes("os.environ.get('NEMOCLAW_MODEL'") ||
          line.includes('os.environ.get("NEMOCLAW_MODEL"')
        ) {
          hasEnvRead = true;
        }
      }
      if (inPythonRunBlock && !/\\\s*$/.test(line)) {
        inPythonRunBlock = false;
      }
    }
    assert.ok(hasEnvRead, "Python script in the python3 -c RUN block must read NEMOCLAW_MODEL via os.environ");
  });
});
