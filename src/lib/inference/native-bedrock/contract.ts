// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  classifyCustomAnthropicEndpoint,
} from "../bedrock-runtime";
import type { NativeProviderAttachment } from "../native-provider/lifecycle";

/** Non-secret adapter generation evidence, separate from the agent-facing route. */
export type NativeBedrockBinding = Readonly<{
  endpointUrl: string;
  region: string;
  adapterGeneration: string;
  adapterBaseUrl: string;
  gatewayName: string;
}>;
export type NativeBedrockProviderAttachment = NativeProviderAttachment & NativeBedrockBinding;

export function nativeBedrockIdentity(binding: NativeBedrockBinding) {
  const upstream = classifyCustomAnthropicEndpoint(binding.endpointUrl);
  if (
    upstream.kind !== "bedrock-runtime" ||
    upstream.endpointUrl !== binding.endpointUrl ||
    binding.adapterBaseUrl !== BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(binding.region) ||
    !/^[a-f0-9]{32}$/.test(binding.adapterGeneration) ||
    !binding.gatewayName ||
    binding.gatewayName !== binding.gatewayName.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(binding.gatewayName)
  ) {
    throw new Error("Invalid native Bedrock adapter binding.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        binding.endpointUrl,
        binding.region,
        binding.adapterGeneration,
        binding.adapterBaseUrl,
        binding.gatewayName,
      ]),
    )
    .digest("hex");
  // Preserve all 256 digest bits while fitting OpenShell's 64-byte profile type limit.
  const encodedIdentity = BigInt(`0x${digest}`).toString(36).padStart(50, "0");
  return {
    profileId: `nc-bedrock-${encodedIdentity}-v1`,
    providerName: `nc-bedrock-${encodedIdentity}-v1`,
  };
}

export function normalizeNativeBedrockProviderAttachment(
  value: unknown,
): NativeBedrockProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.providerId !== "string" ||
    !row.providerId.trim() ||
    typeof row.endpointUrl !== "string" ||
    typeof row.region !== "string" ||
    typeof row.adapterGeneration !== "string" ||
    typeof row.adapterBaseUrl !== "string" ||
    typeof row.gatewayName !== "string"
  )
    return undefined;
  const binding = {
    endpointUrl: row.endpointUrl,
    region: row.region,
    adapterGeneration: row.adapterGeneration,
    adapterBaseUrl: row.adapterBaseUrl,
    gatewayName: row.gatewayName,
  };
  try {
    const identity = nativeBedrockIdentity(binding);
    if (row.profileId !== identity.profileId || row.providerName !== identity.providerName)
      return undefined;
    return { schemaVersion: 1, providerId: row.providerId, ...identity, ...binding };
  } catch {
    return undefined;
  }
}

/** Bind durable ownership to the selected upstream and named gateway. */
export function requireMatchingNativeBedrockAttachment(
  value: unknown,
  selection: {
    provider?: string | null;
    endpointUrl?: string | null;
    gatewayName?: string | null;
    preferredInferenceApi?: string | null;
  },
): NativeBedrockProviderAttachment | undefined {
  if (value === undefined) return undefined;
  const receipt = normalizeNativeBedrockProviderAttachment(value);
  if (
    !receipt ||
    selection.provider !== "compatible-anthropic-endpoint" ||
    selection.endpointUrl !== receipt.endpointUrl ||
    selection.gatewayName !== receipt.gatewayName ||
    (selection.preferredInferenceApi != null &&
      selection.preferredInferenceApi !== "openai-completions")
  )
    throw new Error("Native Bedrock ownership does not match the selected route.");
  return receipt;
}

export function isNativeBedrockSelection(selection: {
  provider?: string | null;
  endpointUrl?: string | null;
}): boolean {
  return (
    selection.provider === "compatible-anthropic-endpoint" &&
    typeof selection.endpointUrl === "string" &&
    classifyCustomAnthropicEndpoint(selection.endpointUrl).kind === "bedrock-runtime"
  );
}
