// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { recordedNativeProviderAttachment } from "../../inference/native-provider/recorded-selection";
import { fixedNativeProviderForAttachment } from "../../inference/native-provider/fixed";
import { isDeepStrictEqual } from "node:util";
import { VLLM_LOCAL_CREDENTIAL_ENV } from "../../inference/serving/vllm-credential-contract";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import type { Provider } from "../openshell/providers";
import type { SandboxEntry } from "../../state/registry/types";
import { normalizeInferenceSelection } from "../../inference/selection";

export function providerContract(api: string | null | undefined) {
  if (api?.startsWith("anthropic")) {
    return { type: "anthropic", configKey: "ANTHROPIC_BASE_URL" } as const;
  }
  const type = api?.startsWith("openai") ? "openai" : null;
  return { type, configKey: "OPENAI_BASE_URL" } as const;
}

function expectedCredentialKeys(credentialEnv: string | null, routeProvider: string): string[] {
  // vLLM onboarding always registers this gateway-owned key, including for
  // legacy host-local installs whose registry credential remains null.
  if (routeProvider === "vllm-local") return [VLLM_LOCAL_CREDENTIAL_ENV];
  // Ollama onboarding has no user credential; its managed proxy still authenticates the route.
  if (routeProvider === "ollama-local" && credentialEnv === null)
    return [OLLAMA_LOCAL_CREDENTIAL_ENV];
  return credentialEnv === null ? [] : [credentialEnv];
}

export type NativeInferenceReceipt = NativeProviderAttachment;

function matchesNativeProviderMetadata(
  provider: Provider,
  normalized: ReturnType<typeof normalizeInferenceSelection>,
  routeProvider: string,
  receipt: NativeInferenceReceipt,
): boolean {
  return isDeepStrictEqual(
    [
      provider.name,
      provider.id,
      provider.type,
      provider.credentialKeys,
      provider.configKeys,
      provider.managedProfile?.id,
    ],
    [
      routeProvider,
      receipt.providerId,
      receipt.profileId,
      [fixedNativeProviderForAttachment(receipt).credentialEnv],
      [],
      receipt.profileId,
    ],
  );
}

export function matchesProviderMetadata(
  provider: Provider,
  normalized: ReturnType<typeof normalizeInferenceSelection>,
  routeProvider: string,
  managed: boolean,
  nativeReceipt?: NativeInferenceReceipt,
): boolean {
  if (nativeReceipt !== undefined) {
    return matchesNativeProviderMetadata(provider, normalized, routeProvider, nativeReceipt);
  }
  const { type, configKey } = providerContract(normalized.preferredInferenceApi);
  const builtin = provider.builtinInferenceEndpoint !== undefined;
  // OpenShell's CLI writes the selected workspace for a newly created
  // provider, while legacy records and protobuf defaults can leave the field
  // empty. A different workspace is outside this direct provider contract.
  const managedBindingMatches =
    !managed ||
    ((provider.profileWorkspace === undefined ||
      provider.profileWorkspace === "" ||
      provider.profileWorkspace === provider.workspace) &&
      provider.managedProfile === undefined);
  return (
    type !== null &&
    managedBindingMatches &&
    isDeepStrictEqual(
      [provider.name, provider.type, provider.credentialKeys, provider.configKeys],
      [
        routeProvider,
        builtin ? "nvidia" : type,
        expectedCredentialKeys(normalized.credentialEnv, routeProvider),
        builtin ? [] : [configKey],
      ],
    )
  );
}

export function resolveExportInferenceSelection(entry: Readonly<SandboxEntry>) {
  return {
    normalized: normalizeInferenceSelection(entry),
    nativeReceipt: recordedNativeProviderAttachment(entry),
  };
}
