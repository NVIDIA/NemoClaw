// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama local inference provider setup flow.
// Extracted verbatim from onboard.setupInference (#767).

import { normalizeHostLocalOllamaModelRef } from "../runtime-provider/host-local-inference";
import type { OllamaDeps, SetupInferenceResult } from "./types";

export async function setupOllamaLocalInference(
  args: {
    model: string;
    provider: string;
    allowToolsIncompatible: boolean;
    preparedProxyToken?: string;
  },
  deps: OllamaDeps,
): Promise<{ done: true; result: SetupInferenceResult } | { done: false }> {
  const { model, provider, allowToolsIncompatible } = args;
  const {
    upsertProvider,
    validateLocalProvider,
    getLocalProviderBaseUrl,
    applyLocalInferenceRoute,
    run,
    shouldFrontOllamaWithProxy,
    ensureOllamaAuthProxy,
    isProxyHealthy,
    getOllamaProxyToken,
    persistAndProbeOllamaProxy,
    localInference,
    providerOwnedInferenceProof,
    OLLAMA_PROXY_CREDENTIAL_ENV,
    exitProcess,
    error,
    log,
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
      if (!args.preparedProxyToken) ensureOllamaAuthProxy();
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
      error(`  ${validation.message}`);
      if (validation.diagnostic) {
        error(`  Diagnostic: ${validation.diagnostic}`);
      }
      if (process.platform === "darwin") {
        error("  On macOS, local inference also depends on OpenShell host routing support.");
      }
      return exitProcess(1);
    }
  }
  // Prove the model on the endpoint being recorded, not only on the host-side
  // daemon every check above resolves through. Those are two different Ollama
  // processes when WSL and Windows each run one (#9454).
  const sandboxModel = localInference.validateSandboxFacingOllamaModel(model);
  if (!sandboxModel.ok) {
    error(`  ${sandboxModel.message}`);
    return exitProcess(1);
  }
  const baseUrl = getLocalProviderBaseUrl(provider);
  let ollamaCredential = "ollama";
  if (frontOllamaWithProxy) {
    // The normal onboarding path prepares the proxy once, after review. The
    // fallback remains for recovery callers that enter provider setup without
    // a prepared token.
    if (!args.preparedProxyToken && !proxyReady) ensureOllamaAuthProxy();
    const proxyToken = args.preparedProxyToken ?? getOllamaProxyToken();
    if (!proxyToken) {
      error("  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.");
      return exitProcess(1);
    }
    ollamaCredential = proxyToken;
    if (!args.preparedProxyToken) {
      await persistAndProbeOllamaProxy(proxyToken);
    }
  }
  let rollbackPersistedOllamaHost: () => void;
  try {
    rollbackPersistedOllamaHost = localInference.persistResolvedOllamaHost();
  } catch (persistError) {
    error(
      `  Could not stage the selected local Ollama route for later stop/destroy cleanup: ${
        persistError instanceof Error ? persistError.message : String(persistError)
      }`,
    );
    return exitProcess(1);
  }
  const rollbackCleanupRoute = (): boolean => {
    try {
      rollbackPersistedOllamaHost();
      return true;
    } catch (rollbackError) {
      error(
        `  Could not restore the prior local Ollama cleanup route: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
      );
      return false;
    }
  };
  // Use a dedicated internal credential env (NEMOCLAW_OLLAMA_PROXY_TOKEN)
  // so the gateway never reads the user's host OPENAI_API_KEY for local
  // Ollama. GH #2519: a stale host OPENAI_API_KEY was leaking into the
  // inference path and producing 401s.
  let providerResult: ReturnType<typeof upsertProvider>;
  try {
    providerResult = upsertProvider(
      "ollama-local",
      "openai",
      OLLAMA_PROXY_CREDENTIAL_ENV,
      baseUrl,
      { [OLLAMA_PROXY_CREDENTIAL_ENV]: ollamaCredential },
    );
  } catch (providerError) {
    rollbackCleanupRoute();
    throw providerError;
  }
  if (!providerResult.ok) {
    rollbackCleanupRoute();
    error(`  ${providerResult.message}`);
    return exitProcess(providerResult.status || 1);
  }
  let retrySelection: boolean;
  try {
    retrySelection = await applyLocalInferenceRoute("ollama-local", model);
  } catch (routeError) {
    rollbackCleanupRoute();
    throw routeError;
  }
  if (retrySelection) {
    if (!rollbackCleanupRoute()) return exitProcess(1);
    return { done: true, result: { retry: "selection" } };
  }
  if (providerOwnedInferenceProof) {
    if (
      providerOwnedInferenceProof.protocol !== "openai-chat-completions" ||
      providerOwnedInferenceProof.model !== normalizeHostLocalOllamaModelRef(model) ||
      providerOwnedInferenceProof.toolCallingRequired !== !allowToolsIncompatible
    ) {
      rollbackCleanupRoute();
      error("  Provider-owned Ollama proof does not match the accepted model capability request.");
      return exitProcess(1);
    }
  } else {
    let probe: ReturnType<typeof localInference.validateOllamaModelWithToolsOverride>;
    try {
      log(`  Priming Ollama model: ${model}`);
      localInference.runOllamaWarmup(model, run);
      probe = localInference.validateOllamaModelWithToolsOverride(model, allowToolsIncompatible);
    } catch (probeError) {
      rollbackCleanupRoute();
      throw probeError;
    }
    if (!probe.ok) {
      rollbackCleanupRoute();
      error(`  ${probe.message}`);
      return exitProcess(1);
    }
  }
  // Do not mutate ~/.nemoclaw/credentials.json here: local Ollama now uses
  // OLLAMA_PROXY_CREDENTIAL_ENV, so any saved OPENAI_API_KEY remains available
  // to unrelated OpenAI-backed sandboxes.
  return { done: false };
}
