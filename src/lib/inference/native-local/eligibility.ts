// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";

export function isLocalInferenceProvider(provider: string | null | undefined): boolean {
  return provider === "ollama-local" || provider === "vllm-local" || provider === "llama-cpp-local";
}

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
): boolean {
  return (
    (agentName === "openclaw" ||
      agentName === "langchain-deepagents-code" ||
      agentName === "pi" ||
      agentName === "hermes") &&
    usesNativeLocalInference(provider, endpointUrl)
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
    usesNativeLocalInferenceForAgent("pi", recorded.provider, recorded.endpointUrl) &&
    (!selected ||
      (recorded.provider === selected.provider &&
        recorded.model === selected.model &&
        (recorded.endpointUrl ?? null) === (selected.endpointUrl ?? null))),
  );
}
