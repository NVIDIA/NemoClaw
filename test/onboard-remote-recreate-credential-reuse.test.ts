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

describe("onboard recovered remote-provider credential reuse", () => {
  it(
    "re-applies an exact compatible route without exporting or directly validating its gateway credential",
    testTimeoutOptions(90_000),
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-recreate-"));
      const fakeBin = path.join(tmpDir, "bin");
      const home = path.join(tmpDir, "home");
      const scriptPath = path.join(tmpDir, "remote-recreate.cjs");
      const curlLogPath = path.join(tmpDir, "curl-probes.log");
      const openshellLogPath = path.join(tmpDir, "openshell.log");
      const onboardPath = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "onboard.ts"));
      const registryPath = JSON.stringify(
        path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPENSHELL_FAKE_COMMAND_LOG"
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: compatible-endpoint
  Model: nvidia/nemotron-3-ultra
  Version: 1
EOF
fi
if [ "$1" = "provider" ] && [ "$2" = "get" ] && [ "$3" = "-g" ] && [ "$5" = "compatible-endpoint" ]; then
  cat <<'EOF'
Provider:

  Name: compatible-endpoint
  Type: openai
  Credential keys: COMPATIBLE_API_KEY
  Config keys: OPENAI_BASE_URL
EOF
fi
exit 0
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPENSHELL_FAKE_CURL_LOG"
exit 1
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        scriptPath,
        String.raw`
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
delete process.env.NEMOCLAW_PROVIDER;
delete process.env.NEMOCLAW_PROVIDER_KEY;
delete process.env.NEMOCLAW_ENDPOINT_URL;
if (process.env.NEMOCLAW_TEST_KEEP_MODEL_OVERRIDE !== "1") delete process.env.NEMOCLAW_MODEL;
delete process.env.COMPATIBLE_API_KEY;
delete process.env.NVIDIA_INFERENCE_API_KEY;
delete process.env.NVIDIA_API_KEY;

const registry = require(${registryPath});
const registryRoute = {
  provider: "compatible-endpoint",
  model: "nvidia/nemotron-3-ultra",
  endpointUrl: "https://inference-api.nvidia.com/v1",
  preferredInferenceApi: "openai-completions",
  source: "registry",
};
registry.registerSandbox({
  name: "recovered-custom",
  ...registryRoute,
  credentialEnv: "COMPATIBLE_API_KEY",
});
if (process.env.NEMOCLAW_TEST_CONFLICTING_ENDPOINT === "1") {
  registry.registerSandbox({
    name: "conflicting-custom",
    ...registryRoute,
    endpointUrl: "https://other.example/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
  });
}
registry.removeSandbox("recovered-custom");
const { setupNim, setupInference } = require(${onboardPath});

(async () => {
  const selected = await setupNim(null, "recovered-custom", null, true, {
    sandboxName: "recovered-custom",
    route: registryRoute,
  });
  if (!selected.model) throw new Error("setupNim did not recover a model");
  await setupInference(
    "recovered-custom",
    selected.model,
    selected.provider,
    selected.endpointUrl,
    selected.credentialEnv,
    selected.hermesAuthMethod,
    selected.hermesToolGateways,
    {
      preferredInferenceApi: selected.preferredInferenceApi,
      skipHostInferenceSmoke: selected.skipHostInferenceSmoke,
      reuseGatewayCredentialWithoutLocalKey:
        process.env.NEMOCLAW_TEST_OMIT_REUSE_AUTHORIZATION === "1"
          ? undefined
          : selected.reuseGatewayCredentialWithoutLocalKey,
    },
  );
  console.log(JSON.stringify(selected));
})().catch((error) => {
  console.error(error?.stack || error);
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
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            VITEST: "false",
            NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
            NEMOCLAW_TEST_NO_SLEEP: "1",
            OPENSHELL_FAKE_CURL_LOG: curlLogPath,
            OPENSHELL_FAKE_COMMAND_LOG: openshellLogPath,
            COMPATIBLE_API_KEY: "",
            NVIDIA_INFERENCE_API_KEY: "",
            NVIDIA_API_KEY: "",
          },
          timeout: 80_000,
        });
        const output = `${result.stdout || ""}\n${result.stderr || ""}`;

        assert.equal(result.status, 0, output);
        assert.match(output, /Reusing existing gateway credential for 'compatible-endpoint'/);
        assert.match(output, /Reusing existing gateway credential; skipping host inference smoke/);
        assert.match(output, /"skipHostInferenceSmoke":true/);
        assert.match(output, /"reuseGatewayCredentialWithoutLocalKey":true/);
        const curlLog = fs.existsSync(curlLogPath) ? fs.readFileSync(curlLogPath, "utf8") : "";
        const curlUrls = curlLog
          .split(/\s+/u)
          .filter((value) => value.startsWith("http://") || value.startsWith("https://"))
          .map((value) => {
            const parsed = new URL(value);
            return `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}${parsed.search}`;
          });
        assert.deepEqual(
          curlUrls,
          [],
          `remote recovery must not run unrelated local endpoint probes: ${curlLog}`,
        );
        const openshellLog = fs.readFileSync(openshellLogPath, "utf8");
        assert.match(openshellLog, /provider get -g nemoclaw compatible-endpoint/);
        assert.match(
          openshellLog,
          /inference set -g nemoclaw --no-verify --provider compatible-endpoint/,
        );
        assert.ok(
          !openshellLog.includes("provider update -g nemoclaw compatible-endpoint"),
          openshellLog,
        );
        assert.ok(!openshellLog.includes("OPENAI_BASE_URL="), openshellLog);
        assert.ok(!openshellLog.includes("--credential"), openshellLog);

        fs.writeFileSync(openshellLogPath, "");
        const overrideResult = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            VITEST: "false",
            NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
            NEMOCLAW_TEST_NO_SLEEP: "1",
            NEMOCLAW_TEST_KEEP_MODEL_OVERRIDE: "1",
            NEMOCLAW_MODEL: "different/model-override",
            OPENSHELL_FAKE_CURL_LOG: curlLogPath,
            OPENSHELL_FAKE_COMMAND_LOG: openshellLogPath,
            COMPATIBLE_API_KEY: "",
            NVIDIA_INFERENCE_API_KEY: "",
            NVIDIA_API_KEY: "",
          },
          timeout: 80_000,
        });
        const overrideOutput = `${overrideResult.stdout || ""}\n${overrideResult.stderr || ""}`;
        assert.notEqual(overrideResult.status, 0, overrideOutput);
        assert.match(overrideOutput, /recovered model is missing or invalid/);
        const overrideOpenshellLog = fs.readFileSync(openshellLogPath, "utf8");
        assert.ok(
          !overrideOpenshellLog.includes("inference set"),
          `model override must not reach route application: ${overrideOpenshellLog}`,
        );

        fs.writeFileSync(openshellLogPath, "");
        const unauthorizedResult = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            VITEST: "false",
            NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
            NEMOCLAW_TEST_NO_SLEEP: "1",
            NEMOCLAW_TEST_OMIT_REUSE_AUTHORIZATION: "1",
            OPENSHELL_FAKE_CURL_LOG: curlLogPath,
            OPENSHELL_FAKE_COMMAND_LOG: openshellLogPath,
            COMPATIBLE_API_KEY: "",
            NVIDIA_INFERENCE_API_KEY: "",
            NVIDIA_API_KEY: "",
          },
          timeout: 80_000,
        });
        const unauthorizedOutput = `${unauthorizedResult.stdout || ""}\n${unauthorizedResult.stderr || ""}`;
        assert.notEqual(unauthorizedResult.status, 0, unauthorizedOutput);
        assert.match(unauthorizedOutput, /A host credential is required to configure provider/);
        const unauthorizedOpenshellLog = fs.readFileSync(openshellLogPath, "utf8");
        assert.ok(
          !unauthorizedOpenshellLog.includes("provider update") &&
            !unauthorizedOpenshellLog.includes("inference set"),
          `smoke suppression alone must not authorize gateway credential reuse: ${unauthorizedOpenshellLog}`,
        );

        fs.writeFileSync(openshellLogPath, "");
        const conflictingEndpointResult = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}:${process.env.PATH || ""}`,
            VITEST: "false",
            NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
            NEMOCLAW_TEST_NO_SLEEP: "1",
            NEMOCLAW_TEST_CONFLICTING_ENDPOINT: "1",
            OPENSHELL_FAKE_CURL_LOG: curlLogPath,
            OPENSHELL_FAKE_COMMAND_LOG: openshellLogPath,
            COMPATIBLE_API_KEY: "",
            NVIDIA_INFERENCE_API_KEY: "",
            NVIDIA_API_KEY: "",
          },
          timeout: 80_000,
        });
        const conflictingEndpointOutput = `${conflictingEndpointResult.stdout || ""}\n${conflictingEndpointResult.stderr || ""}`;
        assert.notEqual(conflictingEndpointResult.status, 0, conflictingEndpointOutput);
        assert.match(
          conflictingEndpointOutput,
          /recovered endpoint identity is missing or incompatible/,
        );
        assert.doesNotMatch(conflictingEndpointOutput, /Provider: build/);
        assert.ok(
          !conflictingEndpointOutput.includes("Reusing existing gateway credential"),
          conflictingEndpointOutput,
        );
        const conflictingEndpointOpenshellLog = fs.readFileSync(openshellLogPath, "utf8");
        assert.ok(
          !conflictingEndpointOpenshellLog.includes("provider update") &&
            !conflictingEndpointOpenshellLog.includes("inference set"),
          `endpoint drift must fail before provider or route mutation: ${conflictingEndpointOpenshellLog}`,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
