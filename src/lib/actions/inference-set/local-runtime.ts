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
