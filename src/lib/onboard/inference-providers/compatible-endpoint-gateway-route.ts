// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isProtectedLocalInferencePort } from "../../inference/gateway/local-endpoint-ports";
import { DEFAULT_OLLAMA_PROXY_PORT, OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import { COMPATIBLE_ENDPOINT_GATEWAY_PORTS } from "../../inference/native-local/eligibility";
import { isLoopbackHostname } from "../../private-networks";
import type { RunOpenshell, UpsertProvider, UpsertProviderResult } from "./types";

// Keep this list aligned with the materialized host.openshell.internal endpoints
// in nemoclaw-blueprint/policies/presets/local-inference.yaml.
export const BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS = [
  LLAMA_CPP_PORT,
  11434,
  11435,
  VLLM_PORT,
] as const;

export {
  COMPATIBLE_ENDPOINT_GATEWAY_PORTS,
  gatewayReachableCompatibleEndpointUrl,
} from "../../inference/native-local/eligibility";

const COMPATIBLE_ENDPOINT_GATEWAY_PORT_SET = new Set<number>(COMPATIBLE_ENDPOINT_GATEWAY_PORTS);
const NO_AUTH_PROXY_ENDPOINT_INELIGIBLE_ERROR =
  "The no-authentication endpoint is no longer eligible for proxy routing.";

/**
 * Parse the loopback source identity before checking supported and protected ports.
 */
function loopbackNoAuthCompatibleEndpointPort(
  provider: string,
  endpointUrl: string | null | undefined,
): number | null {
  if (
    provider !== "compatible-endpoint" ||
    !endpointUrl ||
    unsafeEndpointUrlViolation(endpointUrl)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return null;
  }
  const port = parsed.port ? Number(parsed.port) : null;
  return parsed.protocol === "http:" &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.hostname.endsWith(".") &&
    isLoopbackHostname(parsed.hostname) &&
    port !== null &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535
    ? port
    : null;
}

export function isLoopbackNoAuthCompatibleEndpointUrl(
  provider: string,
  endpointUrl: string | null | undefined,
): boolean {
  const port = loopbackNoAuthCompatibleEndpointPort(provider, endpointUrl);
  return (
    port !== null &&
    COMPATIBLE_ENDPOINT_GATEWAY_PORT_SET.has(port) &&
    !isProtectedLocalInferencePort(port)
  );
}

/** Revalidate the no-auth endpoint at the proxy's final mutation boundary. */
export function assertLoopbackNoAuthCompatibleEndpointUrl(
  endpointUrl: string,
  options: { allowLegacyRecordedEndpoint?: boolean } = {},
): void {
  const eligible = isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", endpointUrl);
  const authorizedLegacyEndpoint =
    options.allowLegacyRecordedEndpoint === true &&
    isLegacyRecordedLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", endpointUrl);
  if (!eligible && !authorizedLegacyEndpoint) {
    throw new Error(NO_AUTH_PROXY_ENDPOINT_INELIGIBLE_ERROR);
  }
}

/**
 * Recognize the one historical route shape that fresh onboarding now rejects.
 * The caller must also require the durable no-auth proxy credential marker.
 */
export function isLegacyRecordedLoopbackNoAuthCompatibleEndpointUrl(
  provider: string,
  endpointUrl: string | null | undefined,
): boolean {
  return (
    OLLAMA_PROXY_PORT !== DEFAULT_OLLAMA_PROXY_PORT &&
    loopbackNoAuthCompatibleEndpointPort(provider, endpointUrl) === DEFAULT_OLLAMA_PROXY_PORT &&
    !isProtectedLocalInferencePort(DEFAULT_OLLAMA_PROXY_PORT, { allowLegacyProxyDefault: true })
  );
}

export async function reuseRegisteredProviderWithGatewayEndpoint(args: {
  provider: string;
  providerType: string;
  credentialEnv: string | null | undefined;
  endpointUrl: string | null | undefined;
  gatewayEndpointUrl: string | null | undefined;
  runOpenshell: RunOpenshell;
  upsertProvider: UpsertProvider;
}): Promise<UpsertProviderResult> {
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
    return { ok: true };
  }
  return upsertProvider(provider, providerType, credentialEnv, gatewayEndpointUrl, {});
}
