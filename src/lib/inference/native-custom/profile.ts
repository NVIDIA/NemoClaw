// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { NativeCustomAdapterTransport } from "./adapter-transport";
import { isValidName } from "../../name-validation";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import { isLoopbackHostname } from "../../private-networks";
import {
  assertEndpointResolvesPublic,
  isOpenShellManagedHost,
  type EndpointDnsLookupFn,
} from "../../security/trusted-private-endpoint";

export type NativeCustomProvider = "compatible-endpoint" | "compatible-anthropic-endpoint";
export type NativeCustomApi = "openai-completions" | "openai-responses" | "anthropic-messages";

const CUSTOM_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
const BINARIES = [
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/opt/hermes/.venv/bin/python",
  "/opt/hermes/.venv/bin/python3",
  "/opt/venv/bin/python3",
  "/usr/local/bin/curl",
  "/usr/bin/curl",
];

/** Existing host-local selections retain their current owner; this is not endpoint admission. */
export function isHostLocalCustomEndpoint(endpointUrl: string | null | undefined): boolean {
  try {
    const hostname = new URL(endpointUrl || "").hostname;
    return isLoopbackHostname(hostname) || isOpenShellManagedHost(hostname);
  } catch {
    return false;
  }
}

export function isNativeCustomProvider(
  provider: string | null | undefined,
): provider is NativeCustomProvider {
  return provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint";
}

/** Admit a hosted endpoint before constructing any profile or provider identity. */
export async function prepareNativeCustomProfile(input: {
  sandboxName: string;
  provider: NativeCustomProvider;
  endpointUrl: string;
  api: string;
  lookup?: EndpointDnsLookupFn;
  trustedPrivateHosts?: readonly string[];
}) {
  if (!isValidName(input.sandboxName))
    throw new Error("Native custom inference requires a valid selected sandbox name.");
  if (!isNativeCustomProvider(input.provider) || !CUSTOM_APIS.has(input.api)) {
    throw new Error("Unsupported custom provider or inference API.");
  }
  const violation = unsafeEndpointUrlViolation(input.endpointUrl);
  if (violation) throw new Error(`Custom inference endpoint ${violation.reason}`);
  const parsed = new URL(input.endpointUrl.trim());
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /[*[\]{}\\]/u.test(parsed.pathname) ||
    /%2f|%5c/iu.test(parsed.pathname)
  ) {
    throw new Error("Custom inference endpoint must have an exact credential-free URL path.");
  }
  const api = input.api as NativeCustomApi;
  const flavor = api === "anthropic-messages" ? "anthropic" : "openai";
  const endpointUrl = normalizeProviderBaseUrl(parsed, flavor);
  const url = new URL(endpointUrl);
  const admitted = await assertEndpointResolvesPublic(endpointUrl, input.lookup, {
    trustedPrivateHosts: input.trustedPrivateHosts ? [...input.trustedPrivateHosts] : [],
  });
  if (!admitted.ok) throw new Error(`Custom inference endpoint rejected: ${admitted.reason}`);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = [
    ...new Set(
      (admitted.addresses ?? []).length ? (admitted.addresses ?? []) : isIP(host) ? [host] : [],
    ),
  ].sort();
  if (!addresses.length) throw new Error("Custom inference endpoint has no validated address.");
  return {
    ...buildNativeCustomProfile({
      sandboxName: input.sandboxName,
      provider: input.provider,
      endpointUrl,
      api,
      addresses,
    }),
    trustedPrivateEndpoint: admitted.trustedPrivateEndpoint === true,
    ...(admitted.trustedPrivateCapability
      ? { trustedPrivateCapability: admitted.trustedPrivateCapability }
      : {}),
  };
}

/** Construct only from endpoint/address authority already admitted by the caller. */
export function buildNativeCustomProfile(input: {
  sandboxName: string;
  provider: NativeCustomProvider;
  endpointUrl: string;
  api: NativeCustomApi;
  addresses: readonly string[];
  transport?: NativeCustomAdapterTransport;
}) {
  const { endpointUrl, api } = input;
  const url = new URL(endpointUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = [...new Set(input.addresses)].sort();
  const credentialEnv =
    input.provider === "compatible-endpoint"
      ? "COMPATIBLE_API_KEY"
      : "COMPATIBLE_ANTHROPIC_API_KEY";
  const basePath = url.pathname.replace(/\/+$/u, "");
  const apiPath = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
  const operation =
    api === "anthropic-messages"
      ? "messages"
      : api === "openai-responses"
        ? "responses"
        : "chat/completions";
  const identity = createHash("sha256")
    .update(
      JSON.stringify({ endpointUrl, api, credentialEnv, addresses, transport: input.transport }),
    )
    .digest("hex")
    .slice(0, 32);
  const profileId = `nemoclaw-custom-${identity}-v1`;
  const providerIdentity = createHash("sha256")
    .update(JSON.stringify({ profileId, sandboxName: input.sandboxName }))
    .digest("hex")
    .slice(0, 32);
  const profile = {
    id: profileId,
    display_name: "NemoClaw Custom Hosted Inference",
    description: "Endpoint-specific native inference access for NemoClaw agents",
    category: "inference",
    credentials: [
      {
        name: "api_key",
        description: "Custom inference credential",
        env_vars: [credentialEnv],
        required: true,
        auth_style: api === "anthropic-messages" ? "header" : "bearer",
        header_name: api === "anthropic-messages" ? "x-api-key" : "authorization",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: addresses,
        path: `${apiPath}/**`,
        rules: [
          { allow: { method: "GET", path: `${apiPath}/models` } },
          { allow: { method: "POST", path: `${apiPath}/${operation}` } },
        ],
      },
    ],
    binaries: [...BINARIES],
    inference_capable: true,
  };
  return {
    sandboxName: input.sandboxName,
    endpointUrl,
    api,
    credentialEnv,
    ...(input.transport ? { transport: input.transport } : {}),
    providerName: `nemoclaw-custom-${providerIdentity}`,
    profile,
  };
}

export type NativeCustomProfile = Awaited<ReturnType<typeof prepareNativeCustomProfile>>;
