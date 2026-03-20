// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that real API keys are never passed as literal values in --credential
// CLI arguments. Secrets must use the env-lookup form (--credential KEY) so
// they don't appear in `ps aux`.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/325

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Patterns that indicate a real secret is being passed as a literal value
// in a --credential argument. These MUST NOT appear in the codebase.
//
// Safe (env-lookup form):    --credential "NVIDIA_API_KEY"
// Safe (dummy value):        --credential "OPENAI_API_KEY=dummy"
// Safe (ollama value):       --credential "OPENAI_API_KEY=ollama"
// UNSAFE (leaks real key):   --credential "NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}"
// UNSAFE (leaks real key):   --credential f"OPENAI_API_KEY={credential}"

// Allowlist: these KEY=VALUE forms are safe because the values are not secrets
const ALLOWED_CREDENTIAL_VALUES = [
  "OPENAI_API_KEY=dummy",
  "OPENAI_API_KEY=ollama",
  "OPENAI_API_KEY=not-needed",
];

describe("credential exposure: no secrets in --credential CLI args", () => {
  const filesToCheck = [
    { path: "bin/lib/onboard.js", lang: "js" },
    { path: "nemoclaw/src/commands/onboard.ts", lang: "ts" },
    { path: "nemoclaw-blueprint/orchestrator/runner.py", lang: "py" },
  ];

  for (const file of filesToCheck) {
    it(`${file.path}: no secret values in --credential args`, () => {
      const fullPath = path.join(ROOT, file.path);
      if (!fs.existsSync(fullPath)) {
        // File may not exist in all branches; skip gracefully
        return;
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (line.trim().startsWith("//") || line.trim().startsWith("#")) continue;

        // Look for --credential with a KEY=VALUE pattern
        const credMatch = line.match(/--credential[",\s]+["'`]?([A-Z_]+)=(.+?)["'`]/);
        if (!credMatch) continue;

        const key = credMatch[1];
        const fullValue = `${key}=${credMatch[2].replace(/["'`}\s]/g, "")}`;

        // Check if this is in the allowlist
        const isAllowed = ALLOWED_CREDENTIAL_VALUES.some((allowed) =>
          fullValue.startsWith(allowed.replace(/["']/g, ""))
        );

        if (!isAllowed) {
          assert.fail(
            `${file.path}:${i + 1}: --credential passes secret as literal value: "${fullValue}". ` +
            `Use env-lookup form instead: --credential "${key}" ` +
            `(set the env var before the call so openshell reads it internally)`
          );
        }
      }
    });
  }

  it("onboard.js: nvidia-nim provider uses env-lookup form", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/lib/onboard.js"), "utf-8");
    // Find the nvidia-nim provider create block
    const nimBlock = content.match(/provider === "nvidia-nim"[\s\S]*?(?=\} else if|\} else \{)/);
    assert.ok(nimBlock, "Could not find nvidia-nim provider block");

    // Must contain --credential "NVIDIA_API_KEY" (env-lookup, no =value)
    assert.ok(
      nimBlock[0].includes('--credential "NVIDIA_API_KEY"') ||
      nimBlock[0].includes("--credential NVIDIA_API_KEY"),
      'nvidia-nim block must use env-lookup form: --credential "NVIDIA_API_KEY"'
    );

    // Must NOT contain --credential "NVIDIA_API_KEY=${
    assert.ok(
      !nimBlock[0].includes("NVIDIA_API_KEY=${"),
      "nvidia-nim block must NOT interpolate the key value into the credential arg"
    );
  });

  it("onboard.ts: credential passed as env var name only", () => {
    const tsPath = path.join(ROOT, "nemoclaw/src/commands/onboard.ts");
    if (!fs.existsSync(tsPath)) return;
    const content = fs.readFileSync(tsPath, "utf-8");

    // Must set env var before execOpenShell
    assert.ok(
      content.includes("process.env[credentialEnv] = apiKey"),
      "onboard.ts must set process.env[credentialEnv] before execOpenShell"
    );

    // The --credential arg in the provider create/update must NOT contain =
    // Find lines with "--credential" followed by a value containing ${
    const dangerousPattern = /["']--credential["'],\s*[`"']?\$\{credentialEnv\}=\$\{apiKey\}/;
    assert.ok(
      !dangerousPattern.test(content),
      "onboard.ts must not pass credentialEnv=apiKey as --credential value"
    );
  });

  it("runner.py: credential passed as env var name only", () => {
    const pyPath = path.join(ROOT, "nemoclaw-blueprint/orchestrator/runner.py");
    if (!fs.existsSync(pyPath)) return;
    const content = fs.readFileSync(pyPath, "utf-8");

    // Must set os.environ before run_cmd
    assert.ok(
      content.includes("os.environ[target_cred_env] = credential"),
      "runner.py must set os.environ[target_cred_env] before run_cmd"
    );

    // Must NOT have f"OPENAI_API_KEY={credential}" pattern
    assert.ok(
      !content.includes('f"OPENAI_API_KEY={credential}"'),
      'runner.py must not pass f"OPENAI_API_KEY={credential}" as --credential value'
    );
  });
});
