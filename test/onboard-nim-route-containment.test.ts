// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

describe("onboard provider-discovery route containment", () => {
  it(
    "rejects NIM and custom routes before provisioning, credentials, or endpoint probes (#6315)",
    () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nim-route-guard-"));
      const scriptPath = path.join(tmpDir, "nim-route-guard.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
      const credentialsPath = JSON.stringify(
        path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
      );
      const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
      const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));
      const script = String.raw`
const runner = require(${runnerPath});
const credentials = require(${credentialsPath});
const nim = require(${nimPath});
const calls = [];
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command);
  if (/https?:|\/v1\/models|\/api\/tags/.test(text)) calls.push("endpoint-probe");
  return "";
};
credentials.prompt = async () => { calls.push("credential-prompt"); return ""; };
credentials.saveCredential = () => { calls.push("credential-save"); };
nim.listModels = () => [{
  name: "nvidia/nemotron-3-nano-30b-a3b",
  image: "fake",
  minGpuMemoryMB: 8000,
}];
nim.isNgcLoggedIn = () => { calls.push("ngc-login-check"); return true; };
nim.dockerLoginNgc = () => { calls.push("ngc-login"); return true; };
nim.pullNimImage = () => { calls.push("pull"); return "image"; };
nim.containerName = () => { calls.push("container-name"); return "nim-test"; };
nim.startNimContainerByName = () => { calls.push("start"); return "nim-test"; };
nim.waitForNimHealth = () => { calls.push("health"); return true; };
nim.adoptServedModelId = () => { calls.push("served-model"); return "served/model"; };
const { setupNim } = require(${onboardPath});
(async () => {
  const originalLog = console.log;
  console.log = () => {};
  const runGuarded = async (gpu) => {
    calls.length = 0;
    let message = "";
    let route = null;
    try {
      await setupNim(gpu, null, null, true, null, "nemoclaw", (candidate) => {
        route = candidate;
        calls.push("guard");
        throw new Error("route conflict");
      }, () => false);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    return { calls: [...calls], message, route };
  };
  const nimResult = await runGuarded({
    type: "nvidia",
    totalMemoryMB: 16000,
    nimCapable: true,
  });
  process.env.NEMOCLAW_PROVIDER = "custom";
  process.env.NEMOCLAW_MODEL = "custom/model";
  process.env.NEMOCLAW_ENDPOINT_URL = "https://custom.example.test/v1";
  const customResult = await runGuarded(null);
  console.log = originalLog;
  originalLog(JSON.stringify({ customResult, nimResult }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);
      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: repoRoot,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_EXPERIMENTAL: "1",
            NEMOCLAW_MODEL: "nvidia/nemotron-3-nano-30b-a3b",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_PROVIDER: "nim-local",
          },
        });
        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout.trim());
        assert.equal(payload.nimResult.message, "route conflict");
        assert.deepEqual(payload.nimResult.calls, ["guard"]);
        assert.equal(payload.nimResult.route.provider, "vllm-local");
        assert.equal(payload.customResult.message, "route conflict");
        assert.deepEqual(payload.customResult.calls, ["guard"]);
        assert.deepEqual(payload.customResult.route, {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl: "https://custom.example.test/v1",
          preferredInferenceApi: "openai-completions",
          credentialEnv: "COMPATIBLE_API_KEY",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    testTimeout(60_000),
  );
});
