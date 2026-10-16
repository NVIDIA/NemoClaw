// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { LLAMA_CPP_PORT } from "../llama-cpp/contract";

import { isLocalInferenceProvider } from "./agent-config";
export { isLocalInferenceProvider };

/** Hosted compatible endpoints remain with their hosted migration slice. */
export function usesNativeLocalInference(
  provider: string | null | undefined,
  endpointUrl?: string | null,
): boolean {
  if (isLocalInferenceProvider(provider)) return true;
  if (provider !== "compatible-endpoint" || !endpointUrl) return false;
  try {
    const endpoint = new URL(endpointUrl);
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
  localNimSelected = false,
): boolean {
  return (
    !(provider === "vllm-local" && localNimSelected) &&
    (((agentName === "langchain-deepagents-code" || agentName === "hermes") &&
      usesNativeLocalInference(provider, endpointUrl)) ||
      (agentName === "openclaw" && isLocalInferenceProvider(provider)))
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
