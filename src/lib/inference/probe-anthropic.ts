// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Anthropic Messages endpoint probe. Extracted from onboard-probes.ts so the
// credential-routing surface for the Anthropic provider lives in its own
// typed module and the onboard-probes monolith stops growing for vendor-
// specific probes.

import { createXApiKeyAuthConfig } from "../adapters/http/auth-config";
import {
  type AnthropicStreamingProbeResult,
  getCurlTimingArgs,
  runAnthropicStreamingEventProbe,
  runCurlProbe,
} from "../adapters/http/probe";
import { normalizeCredentialValue } from "../credentials/store";

export type AnthropicStreamingDiagnosticCode =
  | "anthropic-streaming-content-after-message-stop"
  | "anthropic-streaming-content-before-message-start"
  | "anthropic-streaming-duplicate-message-start"
  | "anthropic-streaming-duplicate-message-stop"
  | "anthropic-streaming-missing-content-block-delta"
  | "anthropic-streaming-missing-message-start"
  | "anthropic-streaming-missing-message-stop";

export interface AnthropicProbeFailureDetail {
  name: string;
  httpStatus: number;
  curlStatus: number;
  message: string;
  diagnosticCodes?: AnthropicStreamingDiagnosticCode[];
}

export interface AnthropicProbeResult {
  ok: boolean;
  api?: string;
  label?: string;
  message?: string;
  failures?: AnthropicProbeFailureDetail[];
}

export interface AnthropicProbeOptions {
  /**
   * Also validate the `/v1/messages` SSE event sequence with a
   * `stream: true` request. Catches Anthropic-compatible gateways whose
   * non-streaming responses are valid but whose streaming layer is malformed
   * (duplicate `message_start` events, missing content deltas) — agent
   * runtimes only use the streaming path, so the defect otherwise first
   * surfaces in-sandbox as "no final response was produced" (#6289).
   */
  probeStreaming?: boolean;
}

// Streaming validation must not hang the onboarding wizard on an endpoint
// that keeps the SSE connection open: mirror the tighter per-validation
// timing used for /v1/responses streaming checks (issue #1601) instead of
// the 60s default in getCurlTimingArgs(). curl exit 28 (timeout) is
// tolerated by the streaming probe when the required events were already
// collected before the cap.
const STREAMING_PROBE_TIMING_ARGS = ["--connect-timeout", "10", "--max-time", "15"];

function anthropicFailureFromError(error: unknown): AnthropicProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message,
    failures: [{ name: "curl auth config", httpStatus: 0, curlStatus: 0, message }],
  };
}

function anthropicMessagesPayload(model: string, stream: boolean): string {
  return JSON.stringify({
    model,
    max_tokens: 16,
    ...(stream ? { stream: true } : {}),
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
}

const DUPLICATE_EVENT_DIAGNOSTICS: Record<string, AnthropicStreamingDiagnosticCode> = {
  message_start: "anthropic-streaming-duplicate-message-start",
  message_stop: "anthropic-streaming-duplicate-message-stop",
};

const MISSING_EVENT_DIAGNOSTICS: Record<string, AnthropicStreamingDiagnosticCode> = {
  message_start: "anthropic-streaming-missing-message-start",
  content_block_delta: "anthropic-streaming-missing-content-block-delta",
  message_stop: "anthropic-streaming-missing-message-stop",
};

const SEQUENCE_ERROR_DIAGNOSTICS: Record<string, AnthropicStreamingDiagnosticCode> = {
  "content events before message_start": "anthropic-streaming-content-before-message-start",
  "content events after message_stop": "anthropic-streaming-content-after-message-stop",
};

function anthropicStreamingDiagnosticCodes(
  result: Pick<
    AnthropicStreamingProbeResult,
    "duplicateEvents" | "missingEvents" | "sequenceErrors"
  >,
): AnthropicStreamingDiagnosticCode[] {
  return [
    ...result.duplicateEvents.flatMap((event) =>
      DUPLICATE_EVENT_DIAGNOSTICS[event] ? [DUPLICATE_EVENT_DIAGNOSTICS[event]] : [],
    ),
    ...result.missingEvents.flatMap((event) =>
      MISSING_EVENT_DIAGNOSTICS[event] ? [MISSING_EVENT_DIAGNOSTICS[event]] : [],
    ),
    ...result.sequenceErrors.flatMap((error) =>
      SEQUENCE_ERROR_DIAGNOSTICS[error] ? [SEQUENCE_ERROR_DIAGNOSTICS[error]] : [],
    ),
  ];
}

export function probeAnthropicEndpoint(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: AnthropicProbeOptions = {},
): AnthropicProbeResult {
  let authConfig: ReturnType<typeof createXApiKeyAuthConfig> | undefined;
  try {
    authConfig = createXApiKeyAuthConfig(normalizeCredentialValue(apiKey));
    const messagesUrl = `${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`;
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
        anthropicMessagesPayload(model, false),
        messagesUrl,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );
    if (!result.ok) {
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
    }

    if (options.probeStreaming === true) {
      const streamResult = runAnthropicStreamingEventProbe(
        [
          "-sS",
          ...STREAMING_PROBE_TIMING_ARGS,
          ...authConfig.args,
          "-H",
          "anthropic-version: 2023-06-01",
          "-H",
          "content-type: application/json",
          "-d",
          anthropicMessagesPayload(model, true),
          messagesUrl,
        ],
        { trustedConfigFiles: authConfig.trustedConfigFiles },
      );
      if (!streamResult.ok) {
        return {
          ok: false,
          message: `Anthropic Messages API (streaming): ${streamResult.message}`,
          failures: [
            {
              name: "Anthropic Messages API (streaming)",
              httpStatus: streamResult.httpStatus,
              curlStatus: streamResult.curlStatus,
              message: streamResult.message,
              diagnosticCodes: anthropicStreamingDiagnosticCodes(streamResult),
            },
          ],
        };
      }
    }

    return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
  } catch (error) {
    return anthropicFailureFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}
