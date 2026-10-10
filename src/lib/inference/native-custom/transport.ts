// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import {
  normalizeNativeCustomProviderAttachment,
  profileFromCustomAttachment,
  type NativeCustomProviderAttachment,
} from "./index";
import { ensureBedrockRuntimeAdapter } from "../bedrock-runtime-adapter";
import {
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  classifyCustomAnthropicEndpoint,
  hasBedrockRuntimeAwsAuthEnv,
  resolveBedrockRuntimeRegion,
} from "../bedrock-runtime";
import { ensureHttpsPinRuntimeAdapter } from "../https-pin-runtime-adapter";
import {
  buildHttpsPinRouteBaseUrl,
  computeHttpsPinRouteId,
  isHttpsPinRuntimeEligible,
} from "../https-pin-runtime";
import {
  buildNativeCustomProfile,
  prepareNativeCustomProfile,
  type NativeCustomApi,
  type NativeCustomProfile,
  type NativeCustomProvider,
} from "./profile";
import {
  normalizeNativeCustomAdapterTransport,
  type NativeCustomAdapterTransport,
} from "./adapter-transport";

export type NativeCustomTransportDeps = {
  ensureHttpsAdapter?: typeof ensureHttpsPinRuntimeAdapter;
  ensureBedrockAdapter?: typeof ensureBedrockRuntimeAdapter;
  discoverAllowedSourceCidrs: () => readonly string[];
  admitProfile: (prepared: NativeCustomProfile) => Promise<void>;
};

/** Reuse an exact recorded selection without asking the adapter to rotate host credentials. */
export function restoreNativeCustomInference(
  input: {
    sandboxName: string;
    gatewayName: string;
    provider: NativeCustomProvider;
    endpointUrl: string;
    api: string;
  },
  value: NativeCustomProviderAttachment,
): NativeCustomProfile {
  const receipt = normalizeNativeCustomProviderAttachment(value, input.sandboxName);
  const url = new URL(input.endpointUrl);
  if (
    !receipt ||
    unsafeEndpointUrlViolation(input.endpointUrl) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    receipt.api !== input.api ||
    receipt.credentialEnv !==
      (input.provider === "compatible-endpoint"
        ? "COMPATIBLE_API_KEY"
        : "COMPATIBLE_ANTHROPIC_API_KEY") ||
    (receipt.transport && receipt.transport.gatewayName !== input.gatewayName)
  )
    throw new Error("Recorded native custom selection cannot authorize credential reuse.");
  const sourceEndpoint = receipt.transport?.sourceEndpointUrl ?? receipt.endpointUrl;
  const canonical =
    receipt.transport?.kind === "bedrock-runtime"
      ? classifyCustomAnthropicEndpoint(input.endpointUrl).endpointUrl
      : normalizeProviderBaseUrl(url, input.api === "anthropic-messages" ? "anthropic" : "openai");
  if (sourceEndpoint !== canonical)
    throw new Error("Native custom credential reuse requires the exact recorded endpoint.");
  return profileFromCustomAttachment(receipt);
}

/** Retain upstream custody in the established adapter, handing only its token to OpenShell. */
export async function prepareNativeCustomInference(
  input: {
    sandboxName: string;
    gatewayName: string;
    provider: NativeCustomProvider;
    endpointUrl: string;
    api: string;
    credentialValue: string | null;
    lookup?: Parameters<typeof prepareNativeCustomProfile>[0]["lookup"];
    trustedPrivateHosts?: readonly string[];
  },
  deps: NativeCustomTransportDeps,
): Promise<{
  prepared: NativeCustomProfile;
  credentialValue: string | null;
  sourceAddresses?: readonly string[];
  sourceTrustedPrivateCapability?: NativeCustomProfile["trustedPrivateCapability"];
  hostSmoke?: { endpointUrl: string; credentialEnv: string; forceOpenAiLike: boolean };
}> {
  if (!isValidName(input.sandboxName) || !isValidName(input.gatewayName))
    throw new Error("Native custom inference requires a valid sandbox and named gateway.");
  if (unsafeEndpointUrlViolation(input.endpointUrl))
    throw new Error("Invalid native custom endpoint URL.");
  const source = new URL(input.endpointUrl);
  if (source.username || source.password || source.search || source.hash)
    throw new Error("Custom endpoint URL must not carry credentials, query, or fragment.");
  const classification =
    input.provider === "compatible-anthropic-endpoint"
      ? classifyCustomAnthropicEndpoint(input.endpointUrl)
      : null;
  if (classification?.kind !== "bedrock-runtime" && !input.credentialValue?.trim())
    throw new Error(
      "A host credential is required to configure provider. Keyless native custom reuse requires the exact recorded native attachment; a shared beta route cannot authorize it.",
    );
  let transport: NativeCustomAdapterTransport;
  let endpointUrl: string;
  let token: string;
  let hostSmoke:
    | { endpointUrl: string; credentialEnv: string; forceOpenAiLike: boolean }
    | undefined;
  const buildBridge = (
    bridgeEndpoint: string,
    authority: NativeCustomAdapterTransport,
  ): NativeCustomProfile => {
    const admitted = normalizeNativeCustomAdapterTransport(authority, {
      ...input,
      endpointUrl: bridgeEndpoint,
    });
    if (!admitted) throw new Error("Invalid native custom adapter endpoint contract.");
    return {
      ...buildNativeCustomProfile({
        sandboxName: input.sandboxName,
        provider: input.provider,
        endpointUrl: bridgeEndpoint,
        api: input.api as NativeCustomApi,
        addresses: [],
        transport: admitted,
      }),
      trustedPrivateEndpoint: false,
    };
  };
  let prepared: NativeCustomProfile;
  let sourceAddresses: readonly string[] | undefined;
  let sourceTrustedPrivateCapability: NativeCustomProfile["trustedPrivateCapability"];
  if (classification?.kind === "bedrock-runtime") {
    if (input.api !== "openai-completions")
      throw new Error(
        "Bedrock Runtime requires its existing OpenAI Chat Completions adapter surface.",
      );
    if (!input.credentialValue && !hasBedrockRuntimeAwsAuthEnv())
      throw new Error("Bedrock Runtime authentication is missing.");
    transport = {
      kind: "bedrock-runtime",
      gatewayName: input.gatewayName,
      sourceEndpointUrl: classification.endpointUrl,
      region: resolveBedrockRuntimeRegion(classification),
    };
    prepared = buildBridge(BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL, transport);
    await deps.admitProfile(prepared);
    const adapter = await (deps.ensureBedrockAdapter ?? ensureBedrockRuntimeAdapter)({
      classification,
      compatibleCredential: input.credentialValue,
    });
    endpointUrl = adapter.baseUrl;
    token = adapter.token;
    transport = {
      kind: "bedrock-runtime",
      gatewayName: input.gatewayName,
      sourceEndpointUrl: classification.endpointUrl,
      region: adapter.region,
    };
    hostSmoke = {
      endpointUrl: adapter.localBaseUrl,
      credentialEnv: adapter.credentialEnv,
      forceOpenAiLike: true,
    };
  } else {
    const sourceProfile = await prepareNativeCustomProfile(input);
    if (!isHttpsPinRuntimeEligible(sourceProfile.endpointUrl))
      return {
        prepared: sourceProfile,
        credentialValue: input.credentialValue,
        sourceAddresses: sourceProfile.profile.endpoints[0].allowed_ips,
        sourceTrustedPrivateCapability: sourceProfile.trustedPrivateCapability,
      };
    transport = {
      kind: "https-pin",
      gatewayName: input.gatewayName,
      sourceEndpointUrl: sourceProfile.endpointUrl,
      sourceAddresses: sourceProfile.profile.endpoints[0].allowed_ips,
      trustedPrivateEndpoint: sourceProfile.trustedPrivateEndpoint,
    };
    sourceAddresses = sourceProfile.profile.endpoints[0].allowed_ips;
    sourceTrustedPrivateCapability = sourceProfile.trustedPrivateCapability;
    const bridgeEndpoint = `${buildHttpsPinRouteBaseUrl(computeHttpsPinRouteId(input.gatewayName, input.provider, sourceProfile.endpointUrl, input.sandboxName))}/v1`;
    prepared = buildBridge(bridgeEndpoint, transport);
    await deps.admitProfile(prepared);
    const adapter = await (deps.ensureHttpsAdapter ?? ensureHttpsPinRuntimeAdapter)({
      gatewayName: input.gatewayName,
      sandboxName: input.sandboxName,
      provider: input.provider,
      endpointUrl: sourceProfile.endpointUrl,
      providerType: input.api === "anthropic-messages" ? "anthropic" : "openai",
      credentialValue: input.credentialValue || "",
      lookup: async () =>
        sourceProfile.profile.endpoints[0].allowed_ips.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      trustedPrivateHosts: input.trustedPrivateHosts,
      discoverAllowedSourceCidrs: deps.discoverAllowedSourceCidrs,
    });
    endpointUrl = `${adapter.baseUrl}/v1`;
    token = adapter.token;
    transport = {
      kind: "https-pin",
      gatewayName: input.gatewayName,
      sourceEndpointUrl: sourceProfile.endpointUrl,
      sourceAddresses: adapter.pinnedAddresses,
      trustedPrivateEndpoint: sourceProfile.trustedPrivateEndpoint,
    };
  }
  const admittedTransport = normalizeNativeCustomAdapterTransport(transport, {
    ...input,
    endpointUrl,
  });
  if (!admittedTransport || !token.trim())
    throw new Error("Native custom adapter handoff does not match its owned endpoint contract.");
  const observed = buildBridge(endpointUrl, admittedTransport);
  if (JSON.stringify(observed.profile) !== JSON.stringify(prepared.profile))
    throw new Error("Native custom adapter changed its admitted transport boundary.");
  return {
    prepared,
    credentialValue: token,
    hostSmoke,
    sourceAddresses,
    sourceTrustedPrivateCapability,
  };
}
