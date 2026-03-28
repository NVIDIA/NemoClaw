// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Path to nemoclaw dist directory
const NEMOCLAW_DIST_PATH = path.join(__dirname, "..", "nemoclaw", "dist");
const RUNNER_PY_PATH = path.join(__dirname, "..", "nemoclaw-blueprint", "orchestrator", "runner.py");

describe("Sandbox Name Normalization", () => {
  describe("TypeScript normalizeSandboxName (nemoclaw/src/index.ts)", () => {
    const indexPath = path.join(NEMOCLAW_DIST_PATH, "index.js");

    function runNormalizeSandboxName(name, defaultName = "openclaw") {
      // Create a temporary test script file
      const testScriptPath = path.join(os.tmpdir(), `test-sandbox-${Date.now()}.js`);
      const scriptContent = `
const { normalizeSandboxName } = require('${indexPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');
const result = normalizeSandboxName(${JSON.stringify(name)}, ${JSON.stringify(defaultName)});
console.log(JSON.stringify(result));
`;
      fs.writeFileSync(testScriptPath, scriptContent);
      try {
        const result = execSync(`node "${testScriptPath}"`, { encoding: "utf-8", cwd: path.join(__dirname, "..") });
        return JSON.parse(result.trim());
      } finally {
        fs.unlinkSync(testScriptPath);
      }
    }

    it("accepts valid lowercase names", () => {
      const result = runNormalizeSandboxName("my-assistant");
      assert.equal(result, "my-assistant");
    });

    it("normalizes uppercase letters to lowercase", () => {
      const result = runNormalizeSandboxName("My-Assistant");
      assert.equal(result, "my-assistant");
    });

    it("normalizes all uppercase names to lowercase", () => {
      const result = runNormalizeSandboxName("MY-ASSISTANT");
      assert.equal(result, "my-assistant");
    });

    it("accepts names with numbers", () => {
      const result = runNormalizeSandboxName("assistant-123");
      assert.equal(result, "assistant-123");
    });

    it("accepts names starting with numbers", () => {
      const result = runNormalizeSandboxName("123-assistant");
      assert.equal(result, "123-assistant");
    });

    it("returns default for names with special characters", () => {
      const result = runNormalizeSandboxName("my_assistant", "default-sandbox");
      assert.equal(result, "default-sandbox");
    });

    it("returns default for names with spaces", () => {
      const result = runNormalizeSandboxName("my assistant", "default-sandbox");
      assert.equal(result, "default-sandbox");
    });

    it("returns default for empty names", () => {
      const result = runNormalizeSandboxName("", "default-sandbox");
      assert.equal(result, "default-sandbox");
    });

    it("returns default for names longer than 64 characters", () => {
      const longName = "a".repeat(65);
      const result = runNormalizeSandboxName(longName, "default-sandbox");
      assert.equal(result, "default-sandbox");
    });

    it("accepts names exactly 64 characters", () => {
      const name64 = "a".repeat(64);
      const result = runNormalizeSandboxName(name64);
      assert.equal(result, name64);
    });

    it("normalizes mixed case with numbers and hyphens", () => {
      const result = runNormalizeSandboxName("My-Assistant-123-Test");
      assert.equal(result, "my-assistant-123-test");
    });

    it("returns default for non-string input", () => {
      const result = runNormalizeSandboxName(null, "default-sandbox");
      assert.equal(result, "default-sandbox");
    });
  });

  describe("Python normalize_sandbox_name (runner.py)", () => {
    function runNormalizeSandboxName(name) {
      const testScriptPath = path.join(os.tmpdir(), `test-sandbox-py-${Date.now()}.py`);
      const scriptContent = `
import sys
sys.path.insert(0, '${path.dirname(RUNNER_PY_PATH).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
from runner import normalize_sandbox_name
result = normalize_sandbox_name(${JSON.stringify(name)})
print(result)
`;
      fs.writeFileSync(testScriptPath, scriptContent);
      try {
        return execSync(`python3 "${testScriptPath}"`, { encoding: "utf-8" }).trim();
      } finally {
        fs.unlinkSync(testScriptPath);
      }
    }

    function runNormalizeSandboxNameError(name) {
      const testScriptPath = path.join(os.tmpdir(), `test-sandbox-py-err-${Date.now()}.py`);
      // Handle null specially since JSON.stringify(null) becomes "null" not None in Python
      const pythonName = name === null ? "None" : JSON.stringify(name);
      const scriptContent = `
import sys
sys.path.insert(0, '${path.dirname(RUNNER_PY_PATH).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
from runner import normalize_sandbox_name
try:
    normalize_sandbox_name(${pythonName})
    print("NO_ERROR")
except ValueError as e:
    print("ERROR: " + str(e))
except Exception as e:
    print("ERROR: " + str(e))
`;
      fs.writeFileSync(testScriptPath, scriptContent);
      try {
        return execSync(`python3 "${testScriptPath}"`, { encoding: "utf-8" }).trim();
      } finally {
        fs.unlinkSync(testScriptPath);
      }
    }

    it("accepts valid lowercase names", () => {
      const result = runNormalizeSandboxName("my-assistant");
      assert.equal(result, "my-assistant");
    });

    it("normalizes uppercase letters to lowercase", () => {
      const result = runNormalizeSandboxName("My-Assistant");
      assert.equal(result, "my-assistant");
    });

    it("normalizes all uppercase names to lowercase", () => {
      const result = runNormalizeSandboxName("MY-ASSISTANT");
      assert.equal(result, "my-assistant");
    });

    it("accepts names with numbers", () => {
      const result = runNormalizeSandboxName("assistant-123");
      assert.equal(result, "assistant-123");
    });

    it("accepts names starting with numbers", () => {
      const result = runNormalizeSandboxName("123-assistant");
      assert.equal(result, "123-assistant");
    });

    it("rejects names with special characters", () => {
      const result = runNormalizeSandboxNameError("my_assistant");
      assert.ok(result.startsWith("ERROR:"));
      assert.ok(result.includes("lowercase letters, numbers, and hyphens"));
    });

    it("rejects names with spaces", () => {
      const result = runNormalizeSandboxNameError("my assistant");
      assert.ok(result.startsWith("ERROR:"));
    });

    it("rejects non-string input", () => {
      const result = runNormalizeSandboxNameError(null);
      assert.ok(result.startsWith("ERROR:"));
      assert.ok(result.includes("expected") || result.includes("Invalid"));
    });

    it("rejects names longer than 64 characters", () => {
      const longName = "a".repeat(65);
      const result = runNormalizeSandboxNameError(longName);
      assert.ok(result.startsWith("ERROR:"));
      assert.ok(result.includes("64 characters"));
    });

    it("accepts names exactly 64 characters", () => {
      const name64 = "a".repeat(64);
      const result = runNormalizeSandboxName(name64);
      assert.equal(result, name64);
    });

    it("normalizes mixed case with numbers and hyphens", () => {
      const result = runNormalizeSandboxName("My-Assistant-123-Test");
      assert.equal(result, "my-assistant-123-test");
    });
  });
});
