// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

describe("custom endpoint preferred API onboarding", () => {
  it("maps NEMOCLAW_PREFERRED_API=completions to Chat Completions before the route check (#13884)", () => {
    const repoRoot = path.join(import.meta.dirname, "../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preferred-api-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then outfile="$2"; shift 2; else shift; fi
done
body='{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}'
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '200'
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";
const { setupNim } = require(${onboardPath});

async function run(preferredApi) {
  Object.assign(process.env, {
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: "http://localhost:11434/v1",
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_COMPATIBLE_AUTH_MODE: "none",
    NEMOCLAW_PREFERRED_API: preferredApi,
  });
  delete process.env.COMPATIBLE_API_KEY;
  const originalExit = process.exit;
  process.exit = (code) => { throw Object.assign(new Error("exit"), { code }); };
  const guardedApis = [];
  const assertRouteCompatible = (route) => {
    guardedApis.push(route.preferredInferenceApi);
    return { requiredModel: null, requiredEndpointUrl: null, requiredInferenceApi: null };
  };
  try {
    const result = await setupNim(null, null, null, true, null, null, assertRouteCompatible);
    return {
      preferredApi,
      provider: result.provider,
      preferredInferenceApi: result.preferredInferenceApi,
      guardedApis: [...new Set(guardedApis)],
    };
  } catch (error) {
    return { preferredApi, exitCode: error.code };
  } finally {
    process.exit = originalExit;
  }
}

(async () => {
  const originalLog = console.log;
  console.log = () => {};
  const results = [];
  for (const api of ["completions", "chat-completions"]) results.push(await run(api));
  console.log = originalLog;
  originalLog(JSON.stringify(results));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );

    try {
      const childEnv = { ...process.env };
      delete childEnv.COMPATIBLE_API_KEY;
      delete childEnv.NEMOCLAW_PROVIDER_KEY;
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...childEnv, HOME: tmpDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      assert.equal(
        result.status,
        0,
        `${String(result.error ?? "")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.deepEqual(JSON.parse(result.stdout.trim()), [
        {
          preferredApi: "completions",
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          guardedApis: ["openai-completions"],
        },
        {
          preferredApi: "chat-completions",
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          guardedApis: ["openai-completions"],
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
