// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified inference health probing for both local and remote providers.
 * Delegates to probeLocalProviderHealth for vllm-local/ollama-local,
 * and performs lightweight reachability checks for remote cloud providers.
 */

import type { CurlProbeResult } from "./http-probe";
import { runCurlProbe } from "./http-probe";
import { getProviderSelectionConfig } from "./inference-config";
import type { LocalProviderHealthProbeOptions } from "./local-inference";
import { probeLocalProviderHealth } from "./local-inference";
import { BUILD_ENDPOINT_URL } from "./provider-models";

export interface ProviderHealthStatus {
  ok: boolean;
  probed: boolean;
  providerLabel: string;
  endpoint: string;
  detail: string;
}

export interface ProviderHealthProbeOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
}

const COMPATIBLE_PROVIDERS = new Set(["compatible-endpoint", "compatible-anthropic-endpoint"]);

/**
 * Maps remote provider names to their health-check endpoints.
 * Returns null for local providers, compatible-* providers (unknown URL),
 * and unrecognized provider names.
 */
export function getRemoteProviderHealthEndpoint(provider: string): string | null {
  switch (provider) {
    case "nvidia-prod":
    case "nvidia-nim":
      return `${BUILD_ENDPOINT_URL}/models`;
    case "openai-api":
      return "https://api.openai.com/v1/models";
    case "anthropic-prod":
      return "https://api.anthropic.com/v1/models";
    case "gemini-api":
      return "https://generativelanguage.googleapis.com/v1/models";
    default:
      return null;
  }
}

function buildRemoteProbeDetail(
  providerLabel: string,
  endpoint: string,
  reachable: boolean,
  result: CurlProbeResult,
): string {
  if (reachable) {
    return `${providerLabel} endpoint is reachable at ${endpoint}.`;
  }
  return (
    `${providerLabel} endpoint at ${endpoint} is unreachable. ` +
    `Check your network connection. (${result.message})`
  );
}

/**
 * Probes a remote provider endpoint for reachability.
 * Any HTTP response (including 401/403) counts as reachable — we are
 * not authenticating, just checking that the endpoint is up.
 *
 * Returns null for local providers and unrecognized providers.
 * Returns a "not probed" status for compatible-* providers (unknown URL).
 */
export function probeRemoteProviderHealth(
  provider: string,
  options: ProviderHealthProbeOptions = {},
): ProviderHealthStatus | null {
  const config = getProviderSelectionConfig(provider);
  const providerLabel = config?.providerLabel ?? provider;

  if (COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      ok: true,
      probed: false,
      providerLabel,
      endpoint: "",
      detail: "Endpoint URL is not known; skipping reachability check.",
    };
  }

  const endpoint = getRemoteProviderHealthEndpoint(provider);
  if (!endpoint) {
    return null;
  }

  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const result = runCurlProbeImpl(["-sS", "--connect-timeout", "3", "--max-time", "5", endpoint]);

  // For remote providers, curlStatus === 0 means curl connected and got an
  // HTTP response. Even a 401/403 means the endpoint is reachable.
  const reachable = result.curlStatus === 0;

  return {
    ok: reachable,
    probed: true,
    providerLabel,
    endpoint,
    detail: buildRemoteProbeDetail(providerLabel, endpoint, reachable, result),
  };
}

/**
 * Unified provider health probe — tries local first, then remote.
 * Returns null only for completely unrecognized providers.
 */
export function probeProviderHealth(
  provider: string,
  options: ProviderHealthProbeOptions = {},
): ProviderHealthStatus | null {
  const localOptions: LocalProviderHealthProbeOptions = {
    runCurlProbeImpl: options.runCurlProbeImpl,
  };
  const local = probeLocalProviderHealth(provider, localOptions);
  if (local) {
    return {
      ok: local.ok,
      probed: true,
      providerLabel: local.providerLabel,
      endpoint: local.endpoint,
      detail: local.detail,
    };
  }

  return probeRemoteProviderHealth(provider, options);
}
