// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
} from "../native-nvidia/contract";
import { hostedNativeProvider } from "./hosted";
import { hostedNativeProviderForAttachment } from "./hosted-attachment";
import { isLocalInferenceProvider } from "../native-local/agent-config";
import type { NativeProviderAttachment, NativeProviderDefinition } from "./contract";

const nvidiaDefinition: NativeProviderDefinition = {
  logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
  label: "NVIDIA",
  profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
};

export function fixedNativeProvider(
  provider: string | null | undefined,
): NativeProviderDefinition | undefined {
  return provider?.trim() === NVIDIA_HOSTED_LOGICAL_PROVIDER
    ? nvidiaDefinition
    : hostedNativeProvider(provider);
}

/** OpenClaw provider key for a native provider and its selected API. */
export function nativeOpenClawProviderKey(
  provider: string | null | undefined,
  inferenceApi?: string | null,
): "openai" | "anthropic" | "inference" | undefined {
  if (provider === "compatible-endpoint") return "inference";
  if (provider === "compatible-anthropic-endpoint")
    return inferenceApi === "anthropic-messages" ? "anthropic" : "inference";
  // Dedicated local providers route through the managed "inference" provider key.
  if (isLocalInferenceProvider(provider)) return "inference";
  const definition = fixedNativeProvider(provider);
  if (!definition) return undefined;
  if (definition.logicalProvider === "openai-api") return "openai";
  if (definition.logicalProvider === "anthropic-prod") return "anthropic";
  return "inference";
}

export function fixedNativeProviderForAttachment(
  receipt: NativeProviderAttachment,
): NativeProviderDefinition {
  const definition =
    receipt.profileId === nvidiaDefinition.profileId &&
    receipt.providerName === nvidiaDefinition.providerName
      ? nvidiaDefinition
      : hostedNativeProviderForAttachment(receipt);
  if (!definition) throw new Error("Invalid fixed native provider attachment");
  return definition;
}
