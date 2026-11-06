// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeModelRouterEndpoint } from "./model-router";
import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { LLAMA_CPP_PORT } from "../llama-cpp/contract";

import { isLocalInferenceProvider, qualifiedNativeLocalEndpointUrl } from "./agent-config";
export { isLocalInferenceProvider };

/** Hosted compatible endpoints remain with their hosted migration slice. */
export function usesNativeLocalInference(
  provider: string | null | undefined,
  endpointUrl?: string | null,
): boolean {
  if (isLocalInferenceProvider(provider) || nativeModelRouterEndpoint(provider, endpointUrl))
    return true;
  if (provider !== "compatible-endpoint" || !endpointUrl) return false;
  try {
    const endpoint = new URL(endpointUrl);
    if (
      endpoint.hostname === "host.openshell.internal" &&
      qualifiedNativeLocalEndpointUrl(endpointUrl)
    )
      return true;
    return (
      endpoint.protocol === "http:" &&
      [11434, OLLAMA_PROXY_PORT, VLLM_PORT].includes(Number(endpoint.port)) &&
      [
        "localhost",
        "127.0.0.1",
        "[::1]",
        "host.openshell.internal",
        "host.docker.internal",
      ].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

/** Route only the agents whose native local credential consumers are covered by this slice. */
export function usesNativeLocalInferenceForAgent(
  agentName: string | null | undefined,
  provider: string | null | undefined,
  endpointUrl?: string | null,
  _localNimSelected = false,
): boolean {
  if (
    agentName === "pi" &&
    provider === "compatible-endpoint" &&
    endpointUrl &&
    qualifiedNativeLocalEndpointUrl(endpointUrl)
  )
    return true;
  return (
    ((agentName === "langchain-deepagents-code" || agentName === "pi" || agentName === "hermes") &&
      usesNativeLocalInference(provider, endpointUrl)) ||
    (agentName === "openclaw" && usesNativeLocalInference(provider, endpointUrl))
  );
}

/** Preserve only a published Pi selection that still uses its recorded shared route. */
export function isPersistedPiSharedLocalInferenceRoute(
  recorded:
    | {
        agent?: string | null;
        provider?: string | null;
        model?: string | null;
        endpointUrl?: string | null;
        createdAt?: string | null;
        pendingRouteReservation?: boolean;
        nativeLocalProviderAttachment?: unknown;
      }
    | null
    | undefined,
  selected?: { provider?: string | null; model?: string | null; endpointUrl?: string | null },
): boolean {
  return Boolean(
    recorded?.agent === "pi" &&
    typeof recorded.createdAt === "string" &&
    recorded.pendingRouteReservation !== true &&
    recorded.nativeLocalProviderAttachment === undefined &&
    !nativeModelRouterEndpoint(recorded.provider, recorded.endpointUrl) &&
    usesNativeLocalInferenceForAgent("pi", recorded.provider, recorded.endpointUrl) &&
    (!selected ||
      (recorded.provider === selected.provider &&
        recorded.model === selected.model &&
        (recorded.endpointUrl ?? null) === (selected.endpointUrl ?? null))),
  );
}

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
  const routerEndpoint = nativeModelRouterEndpoint(provider, endpointUrl);
  if (routerEndpoint) return routerEndpoint;
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
