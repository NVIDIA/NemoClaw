// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { VLLM_PORT } from "../../core/vllm-port";
import {
  checkOpenAiInferenceProviderProfile,
  OPENAI_GATEWAY_PROVIDER_TYPE,
} from "../../adapters/openshell/provider-profile-registration";
import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import type { RunOpenshell, UpsertProvider, UpsertProviderResult } from "./types";

// Keep this list aligned with the materialized host.openshell.internal endpoints
// in nemoclaw-blueprint/policies/presets/local-inference.yaml.
export const BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS = [
  LLAMA_CPP_PORT,
  11434,
  11435,
  VLLM_PORT,
] as const;

export const COMPATIBLE_ENDPOINT_GATEWAY_PORTS = [11434, 11435, VLLM_PORT] as const;

const COMPATIBLE_ENDPOINT_GATEWAY_PORT_SET = new Set<number>(COMPATIBLE_ENDPOINT_GATEWAY_PORTS);
const LOOPBACK_BRIDGE_PROVIDERS = new Set(["compatible-endpoint", "llama-cpp-local"]);

// #5744: keep host-side validation on the user-entered loopback URL, but
// register the sandbox route through OpenShell's host bridge. Remove this when
// OpenShell can verify provider routes from the sandbox/gateway network context.
export function gatewayReachableCompatibleEndpointUrl(
  provider: string,
  endpointUrl: string | null | undefined,
): string | null | undefined {
  if (!LOOPBACK_BRIDGE_PROVIDERS.has(provider) || !endpointUrl) {
    return endpointUrl;
  }
  const hasExactLoopbackAuthority =
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+(?:[/?#]|$)/i.test(endpointUrl);
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return endpointUrl;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = parsed.port ? Number(parsed.port) : null;
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const usesAllowedBridgePort =
    port !== null &&
    (provider === "llama-cpp-local"
      ? port === LLAMA_CPP_PORT
      : COMPATIBLE_ENDPOINT_GATEWAY_PORT_SET.has(port));
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    hostname.includes("%") ||
    !hasExactLoopbackAuthority ||
    !isLoopback ||
    port === null ||
    !Number.isInteger(port) ||
    !usesAllowedBridgePort
  ) {
    return endpointUrl;
  }
  parsed.hostname = "host.openshell.internal";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname || "/";
  const routeSuffix = `${parsed.search}${parsed.hash}`;
  return parsed.pathname === "/"
    ? `${parsed.origin}${routeSuffix}`
    : `${parsed.origin}${parsed.pathname}${routeSuffix}`;
}

export function reuseRegisteredProviderWithGatewayEndpoint(args: {
  provider: string;
  providerType: string;
  credentialEnv: string | null | undefined;
  endpointUrl: string | null | undefined;
  gatewayEndpointUrl: string | null | undefined;
  runOpenshell: RunOpenshell;
  upsertProvider: UpsertProvider;
}): UpsertProviderResult {
  const {
    provider,
    providerType,
    credentialEnv,
    endpointUrl,
    gatewayEndpointUrl,
    runOpenshell,
    upsertProvider,
  } = args;
  // The caller has already authorized the recovered provider's non-secret
  // credential/config identity through assessRecoveredProviderCredentialReuse.
  const existing = runOpenshell(["provider", "get", provider], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (existing.status !== 0) {
    return {
      ok: false,
      status: existing.status || 1,
      message: `Recovered provider '${provider}' is no longer registered in OpenShell.`,
    };
  }
  if (gatewayEndpointUrl === endpointUrl) {
    if (providerType !== OPENAI_GATEWAY_PROVIDER_TYPE) return { ok: true };
    // #9895: an unchanged gateway route performs no upsert, so the shared
    // provider-profile boundary in setup-inference never runs here. A provider
    // that an earlier NemoClaw registered without the `openai` profile stays
    // unclassifiable, and the sandbox supervisor keeps rejecting the provider
    // environment until the profile import lands. Declare it here as well.
    const profile = checkOpenAiInferenceProviderProfile({ runOpenshell });
    return profile.ok
      ? { ok: true }
      : { ok: false, status: 1, message: profile.messages.join("\n").trim() };
  }
  return upsertProvider(provider, providerType, credentialEnv, gatewayEndpointUrl, {});
}
