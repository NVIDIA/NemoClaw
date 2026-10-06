// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "./endpoint";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../ollama/contract";
import { isBedrockRuntimeEndpoint } from "../bedrock-runtime";
import { isLoopbackHostname } from "../../core/endpoint-url-safety";
import { isOpenShellManagedHost } from "../endpoint-ssrf-preflight";
import type { NativeProviderAttachment } from "../native-provider/lifecycle";
import { nativeCompatibleEndpointIdentity, type NativeCompatibleApi } from "./endpoint";

export type NativeCompatibleProviderAttachment = NativeProviderAttachment &
  Readonly<{
    endpointUrl: string;
    api: NativeCompatibleApi;
    addresses: readonly string[];
  }>;

/** A receipt cannot authorize another endpoint or request protocol. */
export function normalizeNativeCompatibleProviderAttachment(
  value: unknown,
): NativeCompatibleProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.endpointUrl !== "string" ||
    typeof row.api !== "string" ||
    !Array.isArray(row.addresses) ||
    row.addresses.some((address) => typeof address !== "string") ||
    typeof row.providerId !== "string" ||
    !row.providerId.trim()
  )
    return undefined;
  try {
    const identity = nativeCompatibleEndpointIdentity({
      endpointUrl: row.endpointUrl,
      api: row.api,
      addresses: row.addresses as string[],
    });
    if (
      row.profileId !== identity.profileId ||
      row.providerName !== identity.providerName ||
      row.endpointUrl !== identity.endpoint
    )
      return undefined;
    return {
      schemaVersion: 1,
      profileId: identity.profileId,
      providerName: identity.providerName,
      providerId: row.providerId,
      endpointUrl: identity.endpoint,
      api: identity.api,
      addresses: identity.addresses!,
    };
  } catch {
    return undefined;
  }
}

export function isNativeCompatibleSelection(provider: string | null | undefined): boolean {
  return provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint";
}

/** Preserve the OpenAI frontend used by Hermes and Deep Agents for Anthropic-compatible endpoints. */
export function nativeCompatibleSelectionIdentity(input: {
  provider: string;
  endpointUrl: string;
  api: string;
}) {
  const endpointUrl =
    input.provider === "compatible-anthropic-endpoint" && input.api !== "anthropic-messages"
      ? getCompatibleAnthropicOpenAiSurfaceBaseUrl(input.endpointUrl)
      : input.endpointUrl;
  return nativeCompatibleEndpointIdentity({ endpointUrl, api: input.api });
}

/** Reject a stored receipt when the selected endpoint or API has changed. */
export function requireMatchingNativeCompatibleAttachment(
  value: unknown,
  selection: {
    provider?: string | null;
    endpointUrl?: string | null;
    preferredInferenceApi?: string | null;
  },
): NativeCompatibleProviderAttachment | undefined {
  if (value === undefined) return undefined;
  const receipt = normalizeNativeCompatibleProviderAttachment(value);
  const api =
    selection.preferredInferenceApi ||
    (selection.provider === "compatible-anthropic-endpoint"
      ? "anthropic-messages"
      : "openai-completions");
  if (!receipt || !isNativeCompatibleSelection(selection.provider) || !selection.endpointUrl)
    throw new Error("Native compatible provider receipt does not match the selected endpoint.");
  const identity = nativeCompatibleSelectionIdentity({
    provider: selection.provider ?? "",
    endpointUrl: selection.endpointUrl,
    api,
  });
  if (identity.endpoint !== receipt.endpointUrl || identity.api !== receipt.api)
    throw new Error("Native compatible provider receipt does not match the selected endpoint.");
  return receipt;
}

/** Host-local and adapter-backed selections retain their separately owned migration paths. */
export function isNativeCompatibleHostedSelection(selection: {
  provider?: string | null;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
}): boolean {
  if (
    !isNativeCompatibleSelection(selection.provider) ||
    selection.credentialEnv === OLLAMA_LOCAL_CREDENTIAL_ENV
  )
    return false;
  if (
    selection.provider === "compatible-anthropic-endpoint" &&
    isBedrockRuntimeEndpoint(selection.endpointUrl)
  )
    return false;
  if (!selection.endpointUrl) return true;
  try {
    const host = new URL(selection.endpointUrl).hostname.replace(/\.$/, "");
    return !isLoopbackHostname(host) && !isOpenShellManagedHost(host);
  } catch {
    return true;
  }
}
