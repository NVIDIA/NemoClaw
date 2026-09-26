// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isProtectedNemoClawHostPort } from "../../core/protected-host-ports";
import { DEFAULT_OLLAMA_PROXY_PORT, OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import { isLoopbackHostname } from "../../private-networks";
import {
  listRecordedGatewayPorts,
  listRecordedModelRouterPorts,
  resolveHome,
} from "../../state/gateway-registry";
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
const NO_AUTH_PROXY_ENDPOINT_INELIGIBLE_ERROR =
  "The no-authentication endpoint is no longer eligible for proxy routing.";

/**
 * Validate the source identity of a compatible endpoint onboarded through the
 * protected no-auth proxy. The proxy may forward to an explicit unprivileged
 * loopback port that is not reserved for NemoClaw's control plane, even though
 * direct sandbox bridge routes use a fixed port set.
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
  const home = resolveHome();
  return (
    port !== null &&
    !isProtectedNemoClawHostPort(port, listRecordedModelRouterPorts(home)) &&
    !listRecordedGatewayPorts(home).includes(port)
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
    loopbackNoAuthCompatibleEndpointPort(provider, endpointUrl) === DEFAULT_OLLAMA_PROXY_PORT
  );
}

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
