// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

export type SmokeVerifierHarnessCall = [string, ...unknown[]];

type VerifyOnboardSmokeInvocation = {
  credentialEnv?: string;
  endpointUrl?: string;
  forceOpenAiLike?: boolean;
  model?: string;
  provider?: string;
};

export function runVerifyOnboardSmokeHarness(
  invocations: VerifyOnboardSmokeInvocation[],
): SmokeVerifierHarnessCall[] {
  const harness = String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];

process.env.VITEST = "false";

Module._load = function patchedLoad(request, _parent, _isMain) {
  if (request === "../credentials/store") {
    return {
      getCredential(name) {
        calls.push(["getCredential", name]);
        return "stored-" + name;
      },
      normalizeCredentialValue(value) {
        calls.push(["normalizeCredentialValue", value]);
        return value;
      },
      resolveProviderCredential(name) {
        calls.push(["resolveProviderCredential", name]);
        return "resolved-" + name;
      },
    };
  }
  if (request === "../hermes-provider-auth") {
    return {
      HERMES_PROVIDER_NAME: "hermes-provider",
      HERMES_INFERENCE_CREDENTIAL_ENV: "OPENAI_API_KEY",
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
    };
  }
  if (request === "../adapters/http/probe") {
    return {
      getCurlTimingArgs() {
        return [];
      },
      runChatCompletionsStreamingProbe() {
        throw new Error("unexpected streaming probe");
      },
      runCurlProbe(args) {
        const authHeader =
          args.find((arg) => String(arg).startsWith("Authorization: Bearer ")) || "no-auth";
        calls.push(["runCurlProbe", args[args.length - 1], authHeader]);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          message: "OK",
          body: '{"choices":[{"message":{"content":"OK"}}]}',
        };
      },
      runStreamingEventProbe() {
        throw new Error("unexpected streaming event probe");
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { verifyOnboardInferenceSmoke } = require(process.env.PROBES_MODULE);
const invocations = JSON.parse(process.env.SMOKE_INVOCATIONS || "[]");
console.log = (...args) => calls.push(["log", args.join(" ")]);

for (const invocation of invocations) {
  verifyOnboardInferenceSmoke({
    endpointUrl: "https://api.example.com/v1",
    model: "nous/test-model",
    provider: "hermes-provider",
    ...invocation,
  });
}

process.stdout.write(JSON.stringify(calls));
`;
  const result = spawnSync(process.execPath, ["-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PROBES_MODULE: path.join(process.cwd(), "dist/lib/inference/onboard-probes.js"),
      SMOKE_INVOCATIONS: JSON.stringify(invocations),
      VITEST: "false",
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "smoke verifier harness failed");
  }
  return JSON.parse(result.stdout) as SmokeVerifierHarnessCall[];
}
