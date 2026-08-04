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
    getManagedVllmProviderBinding,
    exitProcess,
    error,
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
      error(`  ${validation.message}`);
      if (validation.diagnostic) {
        error(`  Diagnostic: ${validation.diagnostic}`);
      }
      return exitProcess(1);
    }
  }
  let managedBinding: ReturnType<typeof getManagedVllmProviderBinding>;
  try {
    managedBinding = getManagedVllmProviderBinding();
  } catch {
    error("  Managed vLLM authentication state is unsafe or unreadable.");
    return exitProcess(1);
  }
  const baseUrl = managedBinding?.baseUrl ?? getLocalProviderBaseUrl(provider);
  const providerToken = managedBinding?.apiKey ?? "dummy";
  // Use a dedicated internal credential env so the gateway does not pick
  // up the user's host OPENAI_API_KEY for local vLLM. vLLM does not enforce
  // the bearer for legacy single-host installs; managed dual-Station vLLM
  // uses the private persisted key. The dedicated env name prevents
  // accidental hijacking by a host OPENAI_API_KEY. See GH #2519.
  const providerResult = upsertProvider(
    "vllm-local",
    "openai",
    VLLM_LOCAL_CREDENTIAL_ENV,
    baseUrl,
    { [VLLM_LOCAL_CREDENTIAL_ENV]: providerToken },
  );
  if (!providerResult.ok) {
    error(`  ${providerResult.message}`);
    return exitProcess(providerResult.status || 1);
  }
  if (await applyLocalInferenceRoute("vllm-local", model)) {
    return { done: true, result: { retry: "selection" } };
  }
  // Do not mutate ~/.nemoclaw/credentials.json here: local vLLM now uses
  // VLLM_LOCAL_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
  // to unrelated OpenAI-backed sandboxes.
  return { done: false };
}
