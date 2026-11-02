// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeModelRouterEndpoint } from "../../inference/native-local/model-router";
import { loadBlueprintProfile } from "../../core/model-router-port";
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
import {
  getNimInferenceEndpoints,
  getServedModelId,
  getNimContextWindow,
} from "../../inference/nim";
import type { NativeLocalProviderAttachment } from "../../inference/native-local/profile";
import type { RegistryInferenceMetadata } from "../inference-set-route-containment";
import type { InferenceSetProviderBinding } from "../inference-set-route-containment";
import { InferenceSetError } from "../inference-set-error";

export { validateLocalProvider, type ValidationResult } from "../../inference/local";

export type NimSwitchSelection = {
  nimContainer: string;
  endpointUrl: string;
  contextWindow: number | null;
};

/** Verify the NIM owner selected by the registry or matching onboard session. */
export function verifyNimSwitchSelection(
  provider: string,
  model: string,
  metadata: RegistryInferenceMetadata,
  previous?: NativeLocalProviderAttachment,
  requireNimSelection = false,
): NimSwitchSelection | undefined {
  if (requireNimSelection && !metadata.nimContainer)
    throw new InferenceSetError(
      "Local NVIDIA NIM requires its recorded container and endpoint. Re-run onboarding with NEMOCLAW_PROVIDER=nim-local for this sandbox.",
      2,
    );
  if (provider !== "vllm-local" || !metadata.nimContainer) return;
  const endpointUrl = getNimInferenceEndpoints().baseUrl;
  if (
    metadata.endpointUrl !== endpointUrl ||
    (previous?.provider === provider &&
      (previous.endpointUrl !== endpointUrl || previous.authMode !== "sentinel"))
  )
    throw new InferenceSetError(
      "The recorded NIM route does not match its local runtime. Re-run onboarding to repair it.",
      2,
    );
  if (getServedModelId() !== model)
    throw new InferenceSetError(
      "Local NVIDIA NIM does not serve the selected model. The inference selection was not changed.",
    );
  return {
    nimContainer: metadata.nimContainer,
    endpointUrl,
    contextWindow: getNimContextWindow(model),
  };
}

/** Read the endpoint and credential from the same runtime owners used by onboarding. */
export function resolveLocalSwitchRuntime(
  provider: string,
  resolveCredential: (name: string) => string | null,
  nimSelection?: NimSwitchSelection,
) {
  const routerEndpoint = nativeModelRouterEndpoint(provider);
  if (routerEndpoint) {
    const profile = loadBlueprintProfile("routed");
    const credentialValue = resolveCredential(
      profile?.router.credential_env || profile?.credential_env || "NVIDIA_INFERENCE_API_KEY",
    );
    if (!credentialValue)
      throw new InferenceSetError("The existing Model Router credential is unavailable.");
    return {
      endpointUrl: routerEndpoint,
      credentialValue,
      authMode: "authenticated" as const,
      ownedProxy: false,
    };
  }
  if (provider === "vllm-local" && nimSelection)
    return {
      endpointUrl: nimSelection.endpointUrl,
      credentialValue: "dummy",
      authMode: "sentinel" as const,
      ownedProxy: false,
    };
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
  nimSelection?: NimSwitchSelection,
) {
  if (nativeModelRouterEndpoint(provider)) {
    if (binding)
      throw new InferenceSetError("Model Router uses its configured endpoint and host credential.");
    return resolveLocalSwitchRuntime(provider, resolveCredentialValue);
  }
  if (provider === "vllm-local" && nimSelection) {
    if (binding)
      throw new InferenceSetError(
        "Local NIM cannot use an explicit provider credential binding.",
        2,
      );
    return {
      endpointUrl: nimSelection.endpointUrl,
      credentialValue: "dummy",
      authMode: "sentinel" as const,
      ownedProxy: false,
    };
  }
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
