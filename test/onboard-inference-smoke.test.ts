// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { testTimeoutOptions } from "./helpers/timeouts";

// Coverage guard for #3253. Onboard must not report installation success until
// the configured provider/model route has served a real chat completion. This
// caller-level, mock-driven Vitest test replaces test/e2e/test-onboard-inference-smoke.sh
// per #5119: direct setupInference() probes belong in test/, not in regression-e2e
// bash or the scenario framework. Refs #5098, #4349.
const REPO_ROOT = path.join(import.meta.dirname, "..");

describe("onboard inference smoke guard (#3253)", () => {
  it(
    "rejects a configured OpenAI-compatible route when chat/completions returns 503",
    testTimeoutOptions(90_000),
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-smoke-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "setup-inference-smoke-check.cjs");
      const curlLogPath = path.join(tmpDir, "curl-probes.log");
      const onboardPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(
        path.join(REPO_ROOT, "dist", "lib", "state", "registry.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$NEMOCLAW_FAKE_CURL_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
if [ -n "$out" ]; then
  printf '%s\n' '{"error":{"message":"upstream returned HTTP 503 from compatible-endpoint"}}' > "$out"
fi
printf '503'
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        scriptPath,
        String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const calls = [];
const normalize = (command) => (Array.isArray(command) ? command.join(" ") : String(command));

runner.run = (command) => {
  const text = normalize(command);
  calls.push(["run", text]);
  if (text.includes("provider") && text.includes("upsert")) {
    return { status: 0, stdout: "Created provider compatible-endpoint\n", stderr: "" };
  }
  if (text.includes("inference") && text.includes("set")) {
    return { status: 0, stdout: "Inference configured\n", stderr: "" };
  }
  if (text.includes("/chat/completions")) {
    return {
      status: 22,
      stdout: JSON.stringify({ error: { message: "upstream returned HTTP 503 from compatible-endpoint" } }),
      stderr: "curl: (22) The requested URL returned error: 503",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const text = normalize(command);
  calls.push(["runCapture", text]);
  if (text.includes("inference") && text.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: compatible-endpoint",
      "  Model: broken-model",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = (_name, patch) => calls.push(["registry.updateSandbox", JSON.stringify(patch)]);

process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
process.env.NEMOCLAW_ONBOARD_INFERENCE_SMOKE_E2E = "1";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
process.env.BROKEN_API_KEY = "test-key";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "test-sandbox",
    "broken-model",
    "compatible-endpoint",
    "https://broken.example.invalid/v1",
    "BROKEN_API_KEY",
  );
  console.log(JSON.stringify({ outcome: "resolved", calls }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  console.log(JSON.stringify({ outcome: "rejected", calls }));
  process.exitCode = 3;
});
`,
      );

      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            VITEST: "false",
            NEMOCLAW_TEST_NO_SLEEP: "1",
            NEMOCLAW_FAKE_CURL_LOG: curlLogPath,
            BROKEN_API_KEY: "test-key",
          },
          timeout: 80_000,
        });

        const output = `${result.stdout || ""}\n${result.stderr || ""}`;
        assert.notEqual(
          result.status,
          0,
          `setupInference accepted a configured route without proving chat/completions; output:\n${output}`,
        );
        for (const expectedDiagnostic of [
          /compatible-endpoint/i,
          /broken-model/i,
          /broken\.example\.invalid/i,
          /Credential env: configured/i,
          /503|upstream/i,
        ]) {
          assert.match(
            output,
            expectedDiagnostic,
            `onboard did not surface actionable inference smoke diagnostics; output:\n${output}`,
          );
        }

        const curlLog = fs.existsSync(curlLogPath) ? fs.readFileSync(curlLogPath, "utf8") : "";
        assert.ok(
          curlLog.includes("/chat/completions"),
          `setupInference did not probe chat/completions before failing; curl log:\n${curlLog}`,
        );
        assert.ok(
          !output.includes("Inference route set: compatible-endpoint / broken-model"),
          `setupInference printed route success after the smoke probe failed; output:\n${output}`,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
