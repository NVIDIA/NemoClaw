// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama local inference provider setup flow.
// Extracted verbatim from onboard.setupInference (#767).

import type { OllamaDeps, SetupInferenceResult } from "./types";

export async function setupOllamaLocalInference(
  args: { model: string; provider: string; allowToolsIncompatible: boolean },
  deps: OllamaDeps,
): Promise<{ done: true; result: SetupInferenceResult } | { done: false }> {
  const { model, provider, allowToolsIncompatible } = args;
  const {
    upsertProvider,
    validateLocalProvider,
    getLocalProviderBaseUrl,
    applyLocalInferenceRoute,
    getOllamaWarmupCommand,
    run,
    shouldFrontOllamaWithProxy,
    ensureOllamaAuthProxy,
    isProxyHealthy,
    getOllamaProxyToken,
    persistAndProbeOllamaProxy,
    localInference,
    OLLAMA_PROXY_CREDENTIAL_ENV,
  } = deps;

  const validation = validateLocalProvider(provider);
  let proxyReady = false;
  const frontOllamaWithProxy = shouldFrontOllamaWithProxy();
  if (!validation.ok) {
    // The container reachability check uses Docker's --add-host host-gateway,
    // which may not work on all Docker configurations (e.g., Brev, rootless).
    // The real sandbox uses k3s CoreDNS + NodeHosts — a different path.
    // Try to start/restart the auth proxy before probing — this recovers
    // from stale or missing proxy processes before we decide to abort.
    if (frontOllamaWithProxy) {
      ensureOllamaAuthProxy();
      proxyReady = isProxyHealthy();
    }
    if (proxyReady) {
      console.warn(`  ⚠ ${validation.message}`);
      if (validation.diagnostic) {
        console.warn(`  Diagnostic: ${validation.diagnostic}`);
      }
      console.warn(
        "  The auth proxy is healthy on the host — continuing. " +
          "The sandbox uses a different network path and may work correctly.",
      );
    } else {
      console.error(`  ${validation.message}`);
      if (validation.diagnostic) {
        console.error(`  Diagnostic: ${validation.diagnostic}`);
      }
      if (process.platform === "darwin") {
        console.error(
          "  On macOS, local inference also depends on OpenShell host routing support.",
        );
      }
      process.exit(1);
    }
  }
  const baseUrl = getLocalProviderBaseUrl(provider);
  let ollamaCredential = "ollama";
  if (frontOllamaWithProxy) {
    // Skip if already started during the fallback recovery above.
    if (!proxyReady) ensureOllamaAuthProxy();
    const proxyToken = getOllamaProxyToken();
    if (!proxyToken) {
      console.error(
        "  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.",
      );
      process.exit(1);
    }
    ollamaCredential = proxyToken;
    // Persist token now that ollama-local is confirmed as the provider.
    // Not persisted earlier in case the user backs out to a different provider.
    await persistAndProbeOllamaProxy(proxyToken);
  }
  // Use a dedicated internal credential env (NEMOCLAW_OLLAMA_PROXY_TOKEN)
  // so the gateway never reads the user's host OPENAI_API_KEY for local
  // Ollama. GH #2519: a stale host OPENAI_API_KEY was leaking into the
  // inference path and producing 401s.
  const providerResult = upsertProvider(
    "ollama-local",
    "openai",
    OLLAMA_PROXY_CREDENTIAL_ENV,
    baseUrl,
    { [OLLAMA_PROXY_CREDENTIAL_ENV]: ollamaCredential },
  );
  if (!providerResult.ok) {
    console.error(`  ${providerResult.message}`);
    process.exit(providerResult.status || 1);
  }
  if (await applyLocalInferenceRoute("ollama-local", model)) {
    return { done: true, result: { retry: "selection" } };
  }
  console.log(`  Priming Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  const probe = localInference.validateOllamaModelWithToolsOverride(model, allowToolsIncompatible);
  if (!probe.ok) {
    console.error(`  ${probe.message}`);
    process.exit(1);
  }
  // Do not mutate ~/.nemoclaw/credentials.json here: local Ollama now uses
  // OLLAMA_PROXY_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
  // to unrelated OpenAI-backed sandboxes.
  return { done: false };
}
