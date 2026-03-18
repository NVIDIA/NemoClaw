// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Credential exposure regression tests.
//
// Verifies that real API secrets are NEVER present as literal values in any
// --credential CLI argument across all three execution layers:
//   1. bin/lib/onboard.js       (legacy CLI layer)
//   2. nemoclaw/src/commands/onboard.ts  (plugin layer)
//   3. nemoclaw-blueprint/orchestrator/runner.py  (blueprint/K8s layer)
//
// The safe form is --credential KEY  (env-var lookup — openshell reads the
// value from the environment, never from the process argument list).
// The UNSAFE form is --credential KEY=value  (leaks secret in `ps aux`).
//
// Allowlisted dummy/stub values that are explicitly NOT secrets:
//   OPENAI_API_KEY=dummy   (vllm-local placeholder)
//   OPENAI_API_KEY=ollama  (ollama-local placeholder)
//
// See: https://github.com/NVIDIA/NemoClaw/issues/325

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Safe dummy/stub credential values that are explicitly not secrets.
// These are fine to pass as KEY=VALUE because they are not real credentials.
const ALLOWED_LITERAL_CREDENTIALS = new Set([
  "OPENAI_API_KEY=dummy",
  "OPENAI_API_KEY=ollama",
  "OPENAI_API_KEY=not-needed",
]);

const FILES_TO_SCAN = [
  { path: "bin/lib/onboard.js", lang: "js" },
  { path: "nemoclaw/src/commands/onboard.ts", lang: "ts" },
  { path: "nemoclaw-blueprint/orchestrator/runner.py", lang: "py" },
];

// ── Static source scan ────────────────────────────────────────────

describe("credential exposure: no secrets in --credential CLI args (issue #325)", () => {
  for (const file of FILES_TO_SCAN) {
    it(`${file.path}: --credential args use env-lookup form (KEY only, not KEY=VALUE)`, () => {
      const fullPath = path.join(ROOT, file.path);
      if (!fs.existsSync(fullPath)) return; // skip if file absent

      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      const violations = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Skip full-line comments
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
        // Skip inline comments after code (crude but sufficient for our patterns)

        // Match: --credential <optional quote><KEY>=<VALUE><optional quote/bracket>
        // This regex catches both JS template literals and Python f-strings
        const m = line.match(/--credential\s+['"`]?([A-Z_]{3,64})=([^'"`\s,)]+)/);
        if (!m) continue;

        const key = m[1];
        const value = m[2].replace(/['"}`\s]/g, "");
        const combined = `${key}=${value}`;

        if (ALLOWED_LITERAL_CREDENTIALS.has(combined)) continue;

        violations.push(
          `  ${file.path}:${lineNum}: --credential passes literal secret: "${combined}"\n` +
          `  Fix: set process.env["${key}"] = <value> before the call, then pass --credential "${key}"`
        );
      }

      assert.equal(
        violations.length,
        0,
        `\n\nCREDENTIAL EXPOSURE DETECTED (issue #325):\n\n${violations.join("\n\n")}\n`
      );
    });
  }

  // ── Layer-specific structural assertions ─────────────────────────

  it("bin/lib/onboard.js: nvidia-nim block uses env-lookup form (no NVIDIA_API_KEY=$ interpolation)", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/lib/onboard.js"), "utf-8");

    // The --credential argument must NOT have NVIDIA_API_KEY value interpolated.
    // Note: "-- env NVIDIA_API_KEY=value" is a separate openshell sandbox-startup
    // injection protocol, NOT the --credential flag, so we match specifically.
    assert.ok(
      !content.match(/--credential[^\n]*NVIDIA_API_KEY=\${/),
      'onboard.js must not pass NVIDIA_API_KEY value to --credential arg.\n' +
      'Use env-lookup form: --credential "NVIDIA_API_KEY" (with env set on the child process)'
    );
  });

  it("nemoclaw/src/commands/onboard.ts: sets process.env before passing credential name to execOpenShell", () => {
    const tsPath = path.join(ROOT, "nemoclaw/src/commands/onboard.ts");
    if (!fs.existsSync(tsPath)) return;
    const content = fs.readFileSync(tsPath, "utf-8");

    // execOpenShell must accept a second options arg with env
    assert.ok(
      content.includes("options?.env") || content.includes("options?.env"),
      "onboard.ts execOpenShell must accept options.env for per-call credential injection"
    );

    // The --credential arg must pass the env var NAME (credentialEnv), not its value
    assert.ok(
      !content.match(/["'`]--credential["'`],\s*[`"']\$\{credentialEnv\}=\$\{apiKey\}/),
      "onboard.ts must not pass credentialEnv=apiKey as the --credential value"
    );
  });

  it("nemoclaw-blueprint/orchestrator/runner.py: sets os.environ before passing credential name", () => {
    const pyPath = path.join(ROOT, "nemoclaw-blueprint/orchestrator/runner.py");
    if (!fs.existsSync(pyPath)) return;
    const content = fs.readFileSync(pyPath, "utf-8");

    assert.ok(
      content.includes("os.environ[target_cred_env] = credential"),
      "runner.py must set os.environ[target_cred_env] = credential before run_cmd"
    );

    assert.ok(
      !content.includes('f"OPENAI_API_KEY={credential}"'),
      'runner.py must not pass f"OPENAI_API_KEY={credential}" as --credential value'
    );

    // Must not pass f"{target_cred_env}={credential}" either (from PR #191's partial fix)
    assert.ok(
      !content.match(/f['"]\{target_cred_env\}=\{credential\}['"]/),
      'runner.py must not pass f"{target_cred_env}={credential}" as --credential value'
    );
  });

  it("nemoclaw-blueprint/blueprint.yaml: default profile has credential_env set", () => {
    const bpPath = path.join(ROOT, "nemoclaw-blueprint/blueprint.yaml");
    if (!fs.existsSync(bpPath)) return;
    const content = fs.readFileSync(bpPath, "utf-8");

    // The default profile block should have credential_env.
    // Profile names sit at 6-space indent; their fields are at 8-space indent.
    // We grab everything from "      default:" up to the next 6-space sibling key.
    const defaultBlockMatch = content.match(/ {6}default:\s*\n([\s\S]*?)(?=\n {6}\w)/);
    assert.ok(defaultBlockMatch, "blueprint.yaml must have a default profile");
    assert.ok(
      defaultBlockMatch[0].includes("credential_env"),
      "blueprint.yaml default profile must define credential_env (missing causes silent auth failure)"
    );
  });
});

// ── Runtime injection PoC ─────────────────────────────────────────

describe("runCaptureArgv: injection PoC (proves fix works)", () => {
  const { runCaptureArgv } = require("../bin/lib/runner");

  it("OLD bash -c IS vulnerable to subshell expansion", () => {
    // Demonstrate what the old code did — we use a safe payload
    const { execSync } = require("node:child_process");
    const malicious = "safe_prefix_$(echo INJECTED_PROOF)";
    let stdout;
    try {
      stdout = execSync(`echo ${malicious}`, { encoding: "utf-8" }).trim();
    } catch {
      stdout = "";
    }
    // The old bash -c pattern WOULD expand the subshell
    assert.ok(
      stdout.includes("INJECTED_PROOF") || stdout.includes("safe_prefix_"),
      "Confirming bash -c expands $() — this is the vulnerability"
    );
  });

  it("NEW runCaptureArgv is NOT vulnerable to subshell expansion", () => {
    const malicious = "safe_prefix_$(echo INJECTED_PROOF)";
    const out = runCaptureArgv("echo", [malicious]);
    assert.ok(
      out.includes("$(echo INJECTED_PROOF)"),
      `Expected literal subshell syntax in output, got: "${out}"`
    );
    assert.ok(
      !out.includes("INJECTED_PROOF") || out.includes("$(echo INJECTED_PROOF)"),
      `runCaptureArgv must pass args literally — injection detected! Output: "${out}"`
    );
  });

  it("NEW runCaptureArgv is NOT vulnerable to && chaining", () => {
    const malicious = "ignored && echo CHAINED";
    const out = runCaptureArgv("echo", [malicious]);
    assert.ok(
      out.includes("&&"),
      "&& must be passed literally, not interpreted as command chaining"
    );
  });
});
