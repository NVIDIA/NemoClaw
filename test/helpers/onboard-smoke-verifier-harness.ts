// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

export type SmokeVerifierHarnessCall = [string, ...unknown[]];

type VerifyOnboardSmokeInvocation = {
  selectedChatCapability?: boolean;
  credentialEnv?: string;
  endpointUrl?: string;
  forceOpenAiLike?: boolean;
  model?: string;
  provider?: string;
};

export async function runVerifyOnboardSmokeHarness(
  invocations: VerifyOnboardSmokeInvocation[],
): Promise<SmokeVerifierHarnessCall[]> {
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
    const fs = require("node:fs");
    return {
      getCurlTimingArgs() {
        return [];
      },
      runChatCompletionsStreamingProbe() {
        throw new Error("unexpected streaming probe");
      },
      runCurlProbe(args) {
        let authConfigSummary = "no-auth";
        const configIndex = args.indexOf("--config");
        if (configIndex >= 0 && args[configIndex + 1]) {
          const path = args[configIndex + 1];
          const contents = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
          const headerMatch = contents.match(/header = "([^"]+)"/);
          authConfigSummary = headerMatch ? headerMatch[1] : "config:" + contents.trim();
        }
        calls.push(["runCurlProbe", args[args.length - 1], authConfigSummary]);
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

const {
  getProbeAuthMode,
  getProbeExtraHeaders,
  verifyOnboardInferenceSmoke,
} = require(process.env.PROBES_MODULE);
const { OnboardInferenceCapabilityCache } = require(process.env.CAPABILITY_CACHE_MODULE);
const invocations = JSON.parse(process.env.SMOKE_INVOCATIONS || "[]");
console.log = (...args) => calls.push(["log", args.join(" ")]);

(async () => {
  for (const invocation of invocations) {
    const { selectedChatCapability, ...input } = invocation;
    const capabilityCache = selectedChatCapability ? new OnboardInferenceCapabilityCache() : undefined;
    const effectiveInvocation = {
      endpointUrl: "https://api.example.com/v1",
      model: "nous/test-model",
      provider: "hermes-provider",
      ...input,
    };
    if (capabilityCache) {
      const primed = capabilityCache.rememberCompletedOpenAiChat({
        endpointUrl: effectiveInvocation.endpointUrl,
        model: effectiveInvocation.model,
        authMode: getProbeAuthMode(effectiveInvocation.provider),
        extraHeaders: getProbeExtraHeaders(effectiveInvocation.provider),
      });
      if (!primed) throw new Error("failed to prime selected Chat Completions capability");
    }
    await verifyOnboardInferenceSmoke({
      ...effectiveInvocation,
      capabilityCache,
    });
  }
  process.stdout.write(JSON.stringify(calls));
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ["-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PROBES_MODULE: path.join(process.cwd(), "src/lib/inference/onboard-probes.ts"),
      CAPABILITY_CACHE_MODULE: path.join(
        process.cwd(),
        "src/lib/onboard/inference-capability-cache.ts",
      ),
      SMOKE_INVOCATIONS: JSON.stringify(invocations),
      VITEST: "false",
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "smoke verifier harness failed");
  }
  return JSON.parse(result.stdout) as SmokeVerifierHarnessCall[];
}
