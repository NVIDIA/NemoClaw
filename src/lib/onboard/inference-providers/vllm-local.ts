// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM local inference provider setup flow.
// Extracted verbatim from onboard.setupInference (#767).

import type { SetupInferenceResult, VllmDeps } from "./types";

export async function setupVllmLocalInference(
  args: { model: string; provider: string },
  deps: VllmDeps,
): Promise<{ done: true; result: SetupInferenceResult } | { done: false }> {
  const { model, provider } = args;
  const {
    upsertProvider,
    validateLocalProvider,
    getLocalProviderHealthCheck,
    getLocalProviderBaseUrl,
    applyLocalInferenceRoute,
    run,
    VLLM_LOCAL_CREDENTIAL_ENV,
  } = deps;

  const validation = validateLocalProvider(provider);
  if (!validation.ok) {
    const hostCheck = getLocalProviderHealthCheck(provider);
    // Use run() and check exit status rather than coercing runCapture() output
    // to boolean — curl -sf can leave output even on failure in edge cases.
    const hostResponding = hostCheck
      ? run(hostCheck, { ignoreError: true, suppressOutput: true }).status === 0
      : false;

    if (hostResponding) {
      console.warn(`  ⚠ ${validation.message}`);
      if (validation.diagnostic) {
        console.warn(`  Diagnostic: ${validation.diagnostic}`);
      }
      console.warn(
        "  The server is healthy on the host — continuing. " +
          "The sandbox uses a different network path and may work correctly.",
      );
    } else {
      console.error(`  ${validation.message}`);
      if (validation.diagnostic) {
        console.error(`  Diagnostic: ${validation.diagnostic}`);
      }
      process.exit(1);
    }
  }
  const baseUrl = getLocalProviderBaseUrl(provider);
  // Use a dedicated internal credential env so the gateway does not pick
  // up the user's host OPENAI_API_KEY for local vLLM. vLLM does not enforce
  // the bearer at runtime, but a dedicated env name prevents accidental
  // hijacking. See GH #2519.
  const providerResult = upsertProvider(
    "vllm-local",
    "openai",
    VLLM_LOCAL_CREDENTIAL_ENV,
    baseUrl,
    { [VLLM_LOCAL_CREDENTIAL_ENV]: "dummy" },
  );
  if (!providerResult.ok) {
    console.error(`  ${providerResult.message}`);
    process.exit(providerResult.status || 1);
  }
  if (await applyLocalInferenceRoute("vllm-local", model)) {
    return { done: true, result: { retry: "selection" } };
  }
  // Do not mutate ~/.nemoclaw/credentials.json here: local vLLM now uses
  // VLLM_LOCAL_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
  // to unrelated OpenAI-backed sandboxes.
  return { done: false };
}
