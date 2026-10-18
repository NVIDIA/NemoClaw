// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getLocalProviderBaseUrl,
  getManagedVllmProviderBinding,
  shouldFrontOllamaWithProxy,
} from "../../inference/local";
import { getOllamaProxyToken } from "../../inference/ollama/proxy";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_GATEWAY_BASE_URL,
} from "../../inference/llama-cpp/contract";
import type { InferenceSetProviderBinding } from "../inference-set-route-containment";
import { InferenceSetError } from "../inference-set-error";

export { validateLocalProvider, type ValidationResult } from "../../inference/local";

/** Read the endpoint and credential from the same runtime owners used by onboarding. */
export function resolveLocalSwitchRuntime(
  provider: string,
  resolveCredential: (name: string) => string | null,
) {
  if (provider === "vllm-local") {
    const managed = getManagedVllmProviderBinding();
    return {
      endpointUrl: managed?.baseUrl ?? getLocalProviderBaseUrl(provider),
      credentialValue: managed?.apiKey ?? "dummy",
      authMode: managed ? ("authenticated" as const) : ("sentinel" as const),
      ownedProxy: false,
    };
  }
  if (provider === "ollama-local") {
    const ownedProxy = shouldFrontOllamaWithProxy();
    const credentialValue = ownedProxy ? getOllamaProxyToken() : "ollama";
    if (!credentialValue)
      throw new InferenceSetError(
        "The existing Ollama proxy credential is unavailable. Restore its runtime before switching.",
      );
    return {
      endpointUrl: getLocalProviderBaseUrl(provider),
      credentialValue,
      authMode: ownedProxy ? ("authenticated" as const) : ("sentinel" as const),
      ownedProxy,
    };
  }
  if (provider === "llama-cpp-local") {
    const credentialValue = resolveCredential(LLAMA_CPP_CREDENTIAL_ENV);
    if (!credentialValue)
      throw new InferenceSetError(
        "The existing llama.cpp credential is unavailable. Restore its runtime credential before switching.",
      );
    return {
      endpointUrl: LLAMA_CPP_GATEWAY_BASE_URL,
      credentialValue,
      authMode: "authenticated" as const,
      ownedProxy: false,
    };
  }
  throw new InferenceSetError("Unsupported local provider selection.");
}

/** Resolve Hermes binding overrides without changing its existing credential fallback rules. */
export function resolveHermesLocalSwitchRuntime(
  provider: string,
  binding: InferenceSetProviderBinding | null,
  resolveCredentialValue: (name: string) => string,
) {
  const vllm = provider === "vllm-local" ? getManagedVllmProviderBinding() : null;
  const proxy = provider === "ollama-local" && shouldFrontOllamaWithProxy();
  const endpointUrl =
    binding?.baseUrl ??
    vllm?.baseUrl ??
    (provider === "llama-cpp-local"
      ? LLAMA_CPP_GATEWAY_BASE_URL
      : getLocalProviderBaseUrl(provider));
  if (!endpointUrl)
    throw new Error("The local inference endpoint is unavailable. Run onboarding to qualify it.");
  const credentialValue =
    binding?.token ??
    vllm?.apiKey ??
    (provider === "ollama-local"
      ? proxy
        ? getOllamaProxyToken()
        : "ollama"
      : provider === "vllm-local"
        ? "dummy"
        : resolveCredentialValue(LLAMA_CPP_CREDENTIAL_ENV));
  return {
    endpointUrl,
    credentialValue,
    authMode:
      !binding && !vllm && !proxy && provider !== "llama-cpp-local"
        ? ("sentinel" as const)
        : ("authenticated" as const),
    ownedProxy: proxy,
  };
}
