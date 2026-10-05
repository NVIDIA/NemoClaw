// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { unsafeEndpointUrlViolation, canonicalEndpoint } from "../../core/endpoint-url-safety";
import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
  type EndpointSsrfPreflightOptions,
} from "../../security/trusted-private-endpoint";

export type NativeCompatibleApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Derive resource identity from a canonical endpoint and its API, without network access. */
export function nativeCompatibleEndpointIdentity(input: {
  endpointUrl: string;
  api: string;
  addresses?: readonly string[];
}) {
  if (
    input.api !== "openai-completions" &&
    input.api !== "openai-responses" &&
    input.api !== "anthropic-messages"
  ) {
    throw new Error("Unsupported native compatible endpoint API.");
  }
  const api: NativeCompatibleApi = input.api;
  const endpoint = canonicalEndpoint(
    input.endpointUrl,
    api === "anthropic-messages" ? "anthropic" : "openai",
  );
  if (!endpoint || unsafeEndpointUrlViolation(input.endpointUrl)) {
    throw new Error("A credential-free HTTP(S) endpoint is required.");
  }
  const url = new URL(endpoint);
  // Profile paths are literal access rules. Reject encoded separators and glob syntax.
  if (/%(?:2f|5c|00)|[\\*?{}[\]]/iu.test(url.pathname)) {
    throw new Error("The endpoint path cannot contain encoded separators or pattern syntax.");
  }
  const addresses = input.addresses ? [...new Set(input.addresses)].sort() : undefined;
  if (addresses && (!addresses.length || addresses.some((address) => !isIP(address))))
    throw new Error("A native endpoint profile requires validated IP addresses.");
  const identity = createHash("sha256")
    .update(JSON.stringify(addresses ? [endpoint, api, addresses] : [endpoint, api]))
    .digest("hex");
  return {
    endpoint,
    api,
    ...(addresses ? { addresses } : {}),
    profileId: `nemoclaw-compatible-${identity}-v1`,
    providerName: `nemoclaw-compatible-${identity}-v1`,
  } as const;
}

/** Resolve the existing SSRF boundary before constructing any OpenShell resource. */
export async function prepareNativeCompatibleEndpoint(input: {
  endpointUrl: string;
  api: string;
  lookup?: EndpointDnsLookupFn;
  trust?: EndpointSsrfPreflightOptions;
}) {
  const identity = nativeCompatibleEndpointIdentity(input);
  const { endpoint, api } = identity;
  const url = new URL(endpoint);
  const validation = await assertEndpointResolvesPublic(endpoint, input.lookup, input.trust);
  if (!validation.ok) {
    throw new Error("The hosted endpoint failed network validation.");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = [
    ...new Set(validation.addresses?.length ? validation.addresses : isIP(host) ? [host] : []),
  ].sort();
  if (addresses.length === 0) {
    throw new Error("The hosted endpoint has no validated destination addresses.");
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  const inferencePath =
    api === "anthropic-messages"
      ? `${basePath}/v1/messages`
      : `${basePath}/${api === "openai-responses" ? "responses" : "chat/completions"}`;
  return {
    ...nativeCompatibleEndpointIdentity({ endpointUrl: endpoint, api, addresses }),
    host,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    addresses,
    inferencePath,
    modelsPath: `${basePath}${api === "anthropic-messages" ? "/v1" : ""}/models`,
  } as const;
}

/**
 * Return the OpenAI-compatible base used when a custom Anthropic endpoint is
 * routed through the managed Chat Completions frontend. Anthropic endpoint
 * normalization intentionally strips a trailing `/v1`; OpenShell's OpenAI
 * provider appends `/chat/completions`, so restore `/v1` exactly once here.
 */
export function getCompatibleAnthropicOpenAiSurfaceBaseUrl(
  endpointUrl: string | null | undefined,
): string {
  const trimmed = String(endpointUrl ?? "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
