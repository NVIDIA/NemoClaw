// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateNvidiaApiKeyValue } from "../../../credentials/api-key-validation";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../../../inference/anthropic/openai-surface";
import {
  assertEndpointResolvesPublic,
  parseTrustedPrivateInferenceHostsFromEnv,
} from "../../../inference/endpoint-ssrf-preflight";
import { usesNvidiaEndpointProbePayload } from "../../../inference/openai-probe-models";
import { RETRIABLE_HTTP_PROBE_STATUSES } from "../../../inference/probe/transient-http-policy";
import { getRemoteProviderConfigForName } from "../../../onboard/inference-providers/provider-selection-keys";
import { isBedrockRuntimeEndpoint } from "../../../inference/bedrock-runtime";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";

const { REMOTE_PROVIDER_CONFIG } = require("../../../onboard/providers") as {
  REMOTE_PROVIDER_CONFIG: Record<
    string,
    {
      providerName: string;
      providerType: string;
      endpointUrl: string;
      credentialEnv: string | null;
    }
  >;
};

type ProbeResult = { ok: boolean; validated?: boolean; failures?: unknown[] };

function transientNvidiaValidationFailure(result: ProbeResult): boolean {
  return (
    Array.isArray(result.failures) &&
    result.failures.length > 0 &&
    result.failures.every((failure) => {
      if (typeof failure !== "object" || failure === null) return false;
      const { httpStatus, curlStatus } = failure as Record<string, unknown>;
      return (
        (curlStatus === 0 &&
          typeof httpStatus === "number" &&
          RETRIABLE_HTTP_PROBE_STATUSES.has(httpStatus)) ||
        ((curlStatus === 28 || curlStatus === -110) &&
          (httpStatus === 0 || httpStatus === null || httpStatus === undefined))
      );
    })
  );
}
type Probe = (
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: Record<string, unknown>,
) => ProbeResult | Promise<ProbeResult>;

const probes = require("../../../inference/onboard-probes") as {
  probeAnthropicEndpoint: Probe;
  probeOpenAiLikeEndpointOptimized: Probe;
  getProbeExtraHeaders(provider: string): string[] | undefined;
};

export type HostCredentialTarget = Pick<
  RebuildSandboxEntry,
  "provider" | "model" | "endpointUrl" | "credentialEnv" | "preferredInferenceApi"
>;

/** Validate the host credential that recreate can submit, without changing the gateway. */
export async function validateRebuildHostInferenceCredential(
  target: HostCredentialTarget,
  credentialValue: string,
  deps = {
    assertEndpointResolvesPublic,
    probeAnthropicEndpoint: probes.probeAnthropicEndpoint,
    probeOpenAiLikeEndpointOptimized: probes.probeOpenAiLikeEndpointOptimized,
  },
  onIndeterminate?: () => void,
): Promise<boolean> {
  const config = getRemoteProviderConfigForName(target.provider, REMOTE_PROVIDER_CONFIG);
  // Local, routed, and Hermes authentication retain their existing preflights.
  if (!config || config.providerName === "llama-cpp-local" || target.provider === "hermes-provider")
    return true;
  if (
    target.provider === "compatible-anthropic-endpoint" &&
    isBedrockRuntimeEndpoint(target.endpointUrl)
  ) {
    return true;
  }
  if (validateNvidiaApiKeyValue(credentialValue, target.credentialEnv ?? "")) return false;
  let endpointUrl = config.endpointUrl || target.endpointUrl;
  if (!endpointUrl || !target.model) return false;

  try {
    const pins = !config.endpointUrl
      ? await deps.assertEndpointResolvesPublic(endpointUrl, undefined, {
          trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env),
        })
      : null;
    if (pins && !pins.ok) return false;
    const useAnthropic =
      config.providerType === "anthropic" && target.preferredInferenceApi !== "openai-completions";
    if (config.providerType === "anthropic" && !useAnthropic) {
      endpointUrl = getCompatibleAnthropicOpenAiSurfaceBaseUrl(endpointUrl);
    }
    const probe = useAnthropic
      ? deps.probeAnthropicEndpoint
      : deps.probeOpenAiLikeEndpointOptimized;
    const result = await probe(endpointUrl, target.model, credentialValue, {
      skipResponsesProbe: target.preferredInferenceApi !== "openai-responses",
      probeStreaming: false,
      provider: target.provider,
      extraHeaders: probes.getProbeExtraHeaders(target.provider ?? ""),
      useNvidiaEndpointProbePayload: usesNvidiaEndpointProbePayload(target.provider ?? ""),
      ...(pins?.ok
        ? {
            pinnedAddresses: pins.addresses,
            trustedPrivateCapability: pins.trustedPrivateCapability,
          }
        : {}),
    });
    if (
      !result.ok &&
      usesNvidiaEndpointProbePayload(target.provider ?? "") &&
      transientNvidiaValidationFailure(result)
    ) {
      onIndeterminate?.();
    }
    return result.ok && result.validated !== false;
  } catch {
    // Probe errors and response bodies can contain credentials.
    return false;
  }
}
