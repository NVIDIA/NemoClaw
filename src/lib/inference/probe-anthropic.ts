// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Anthropic Messages endpoint probe. Extracted from onboard-probes.ts so the
// credential-routing surface for the Anthropic provider lives in its own
// typed module and the onboard-probes monolith stops growing for vendor-
// specific probes.

import { createXApiKeyAuthConfig } from "../adapters/http/auth-config";
import { getCurlTimingArgs, runCurlProbe } from "../adapters/http/probe";
import { normalizeCredentialValue } from "../credentials/store";

export interface AnthropicProbeFailureDetail {
  name: string;
  httpStatus: number;
  curlStatus: number;
  message: string;
}

export interface AnthropicProbeResult {
  ok: boolean;
  api?: string;
  label?: string;
  message?: string;
  failures?: AnthropicProbeFailureDetail[];
}

function anthropicFailureFromError(error: unknown): AnthropicProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message,
    failures: [{ name: "curl auth config", httpStatus: 0, curlStatus: 0, message }],
  };
}

export function probeAnthropicEndpoint(
  endpointUrl: string,
  model: string,
  apiKey: string,
): AnthropicProbeResult {
  let authConfig: ReturnType<typeof createXApiKeyAuthConfig> | undefined;
  try {
    authConfig = createXApiKeyAuthConfig(normalizeCredentialValue(apiKey));
    const result = runCurlProbe(
      [
        "-sS",
        ...getCurlTimingArgs(),
        ...authConfig.args,
        "-H",
        "anthropic-version: 2023-06-01",
        "-H",
        "content-type: application/json",
        "-d",
        JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
        `${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
    if (result.ok) {
      return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
    }
    return {
      ok: false,
      message: result.message,
      failures: [
        {
          name: "Anthropic Messages API",
          httpStatus: result.httpStatus,
          curlStatus: result.curlStatus,
          message: result.message,
        },
      ],
    };
  } catch (error) {
    return anthropicFailureFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}
