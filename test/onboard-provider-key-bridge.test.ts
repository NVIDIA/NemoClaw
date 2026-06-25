// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TRACKED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_PROVIDER_KEY",
  "NGC_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "OPENAI_API_KEY",
];

function runSetupNimBridgeScenario(env: Record<string, string>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-key-bridge-"));
  const fakeBin = path.join(tmpDir, "bin");
  const home = path.join(tmpDir, "home");
  const scriptPath = path.join(tmpDir, "bridge-check.cjs");
  const onboardPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "onboard.js"));

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 1\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  printf '%s' '{"data":[{"id":"gpt-5.4"},{"id":"nvidia/llama-3.3-nemotron-super-49b-v1"}]}'> "$outfile"
fi
printf '200'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    scriptPath,
    String.raw`
const { setupNim } = require(${onboardPath});
const env = ${JSON.stringify(env)};
const trackedKeys = ${JSON.stringify(TRACKED_ENV_KEYS)};
for (const key of trackedKeys) delete process.env[key];
Object.assign(process.env, env, {
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_TEST_NO_SLEEP: "1",
});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  process.exit = (code) => {
    const error = new Error("process.exit:" + code);
    error.exitCode = code;
    throw error;
  };
  try {
    const result = await setupNim(null, null, null);
    originalLog(JSON.stringify({ outcome: "completed", result, env: Object.fromEntries(trackedKeys.map((key) => [key, process.env[key] || null])), lines }));
  } catch (error) {
    originalLog(JSON.stringify({ outcome: "exit", exitCode: error.exitCode ?? null, message: error.message, env: Object.fromEntries(trackedKeys.map((key) => [key, process.env[key] || null])), lines }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`,
  );

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_TEST_NO_SLEEP: "1",
      },
      timeout: 60_000,
    });

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as {
      outcome: "completed" | "exit";
      exitCode?: number | null;
      result?: { provider: string; credentialEnv: string | null };
      env: Record<string, string | null>;
      lines: string[];
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("onboard provider-key compatibility bridges", () => {
  it(
    "copies credential-like NEMOCLAW_PROVIDER_KEY into the Model Router credential env",
    testTimeoutOptions(90_000),
    () => {
      const payload = runSetupNimBridgeScenario({
        NEMOCLAW_PROVIDER: "routed",
        NEMOCLAW_PROVIDER_KEY: "sk-router-fallback",
      });

      assert.equal(payload.outcome, "completed");
      assert.equal(payload.result?.provider, "nvidia-router");
      assert.equal(payload.result?.credentialEnv, "NVIDIA_INFERENCE_API_KEY");
      assert.equal(payload.env.NVIDIA_INFERENCE_API_KEY, "sk-router-fallback");
    },
  );

  it(
    "does not copy selector-like NEMOCLAW_PROVIDER_KEY into the Model Router credential env",
    testTimeoutOptions(90_000),
    () => {
      const payload = runSetupNimBridgeScenario({
        NEMOCLAW_PROVIDER: "routed",
        NEMOCLAW_PROVIDER_KEY: "routed",
      });

      assert.equal(payload.outcome, "exit");
      assert.equal(payload.exitCode, 1);
      assert.equal(payload.env.NVIDIA_INFERENCE_API_KEY, null);
      assert.ok(
        payload.lines.some((line) =>
          line.includes("NVIDIA_INFERENCE_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required"),
        ),
      );
    },
  );

  it(
    "does not copy selector-like NEMOCLAW_PROVIDER_KEY into the Build credential env",
    testTimeoutOptions(90_000),
    () => {
      const payload = runSetupNimBridgeScenario({
        NEMOCLAW_PROVIDER: "build",
        NEMOCLAW_PROVIDER_KEY: "build",
      });

      assert.equal(payload.outcome, "exit");
      assert.equal(payload.exitCode, 1);
      assert.equal(payload.env.NVIDIA_INFERENCE_API_KEY, null);
      assert.ok(
        payload.lines.some((line) =>
          line.includes("NVIDIA_INFERENCE_API_KEY (or NEMOCLAW_PROVIDER_KEY) is required"),
        ),
      );
    },
  );

  it(
    "preserves explicit remote-provider credentials over NEMOCLAW_PROVIDER_KEY fallback",
    testTimeoutOptions(90_000),
    () => {
      const payload = runSetupNimBridgeScenario({
        NEMOCLAW_PROVIDER: "openai",
        NEMOCLAW_PROVIDER_KEY: "sk-provider-key-fallback",
        OPENAI_API_KEY: "sk-explicit-openai",
      });

      assert.equal(payload.outcome, "completed");
      assert.equal(payload.result?.provider, "openai-api");
      assert.equal(payload.result?.credentialEnv, "OPENAI_API_KEY");
      assert.equal(payload.env.OPENAI_API_KEY, "sk-explicit-openai");
    },
  );

  it(
    "does not copy selector-like NEMOCLAW_PROVIDER_KEY into remote-provider credential env",
    testTimeoutOptions(90_000),
    () => {
      const payload = runSetupNimBridgeScenario({
        NEMOCLAW_PROVIDER: "openai",
        NEMOCLAW_PROVIDER_KEY: "custom",
      });

      assert.equal(payload.outcome, "exit");
      assert.equal(payload.exitCode, 1);
      assert.equal(payload.env.OPENAI_API_KEY, null);
      assert.ok(
        payload.lines.some((line) =>
          line.includes("Provider credential (or NEMOCLAW_PROVIDER_KEY) is required for OpenAI"),
        ),
      );
    },
  );
});
