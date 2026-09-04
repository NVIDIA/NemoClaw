// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenAiLikeExtraHeaders } from "../adapters/http/auth-config";
import type { CurlProbeResult } from "../adapters/http/probe";
import {
  createValidationSession,
  type ValidationSessionOptions,
} from "../adapters/http/validation-session";
import { retryUntilAsync } from "../core/retry";
import { addTraceEvent, withTraceSpan } from "../trace";
import type { TrustedPrivateEndpointCapability } from "./endpoint-ssrf-preflight";
import {
  getChatCompletionsToolProbePayload,
  isDeepSeekV4ProModel,
  isReasoningOnlyLengthResponse,
  STRICT_TOOL_PROBE_INITIAL_TOKENS,
  STRICT_TOOL_PROBE_RETRY_TOKEN_LADDER,
  strictToolProbeReasoningRetryMessage,
} from "./openai-probe-models";
import { STREAMING_EVENT_PROBE_MAX_SECONDS } from "./probe-http-helpers";
import { RETRIABLE_HTTP_PROBE_STATUSES } from "./probe/transient-http-policy";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export interface OpenAiValidationOptions {
  authMode?: "bearer" | "query-param";
  extraHeaders?: readonly string[];
  requireResponsesToolCalling?: boolean;
  requireChatCompletionsToolCalling?: boolean;
  retryChatCompletionsToolReadiness?: boolean;
  useNvidiaEndpointProbePayload?: boolean;

  skipResponsesProbe?: boolean;
  probeStreaming?: boolean;
  isWsl?: boolean;
  pinnedAddresses?: readonly string[];
  trustedPrivateCapability?: TrustedPrivateEndpointCapability;
  validationSessionOptions?: ValidationSessionOptions;
}

export interface OpenAiValidationResult {
  ok: boolean;
  api?: string | null;
  label?: string | null;
  message?: string;
  failures?: unknown[];
}

export interface OpenAiValidationSessionDeps {
  legacyProbe(
    endpointUrl: string,
    model: string,
    apiKey: string,
    options: OpenAiValidationOptions,
  ): OpenAiValidationResult;
  hasResponsesToolCall(body: string): boolean;
  hasChatCompletionsToolCall(body: string): boolean;
  hasChatCompletionsToolCallLeak(body: string): boolean;
  getChatPayload(model: string, options: OpenAiValidationOptions): Record<string, unknown>;
  getResponsesTimeoutMs(options: OpenAiValidationOptions): number;
  getChatTimeoutMs(model: string, options: OpenAiValidationOptions): number;
  sessionOptions?: ValidationSessionOptions;
}

function responsesPayload(model: string, requireToolCall: boolean, stream = false): string {
  if (!requireToolCall) {
    return JSON.stringify({
      model,
      input: "Reply with exactly: OK",
      ...(stream ? { stream } : {}),
    });
  }
  return JSON.stringify({
    model,
    input: "Call the emit_ok function with value OK. Do not answer with plain text.",
    tool_choice: "required",
    tools: [
      {
        type: "function",
        name: "emit_ok",
        description: "Returns the probe value for validation.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
    ...(stream ? { stream } : {}),
  });
}

function chatToolPayload(model: string, maxTokens = STRICT_TOOL_PROBE_INITIAL_TOKENS): string {
  return JSON.stringify(getChatCompletionsToolProbePayload(model, maxTokens));
}

function failedChatValidation(
  result: CurlProbeResult,
  failureMessage: string,
  diagnosticCodes?: string[],
): OpenAiValidationResult {
  const failure = {
    name: "Chat Completions API with tool calling",
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    message: failureMessage,
    body: result.body,
    ...(diagnosticCodes ? { diagnosticCodes } : {}),
  };
  return {
    ok: false,
    message: `${failure.name}: ${failure.message}`,
    failures: [failure],
  };
}

function failedChatToolCall(result: CurlProbeResult, leaked: boolean): OpenAiValidationResult {
  const failureMessage = leaked
    ? `HTTP ${result.httpStatus}: Chat Completions leaked tool calls into plain text content. ` +
      "Use an endpoint/runtime that returns structured tool_calls (for Hermes on local inference, " +
      "prefer vLLM with --tool-call-parser hermes)."
    : `HTTP ${result.httpStatus}: Chat Completions did not return a tool call`;
  return failedChatValidation(
    result,
    failureMessage,
    leaked
      ? ["openai-chat-tool-call-leak"]
      : isReasoningOnlyLengthResponse(result.body)
        ? ["openai-chat-missing-structured-tool-call", "openai-chat-reasoning-budget-exhausted"]
        : ["openai-chat-missing-structured-tool-call"],
  );
}

function failedChatValidationAfterReasoningRetry(): OpenAiValidationResult {
  const failureMessage = "Chat Completions validation failed after the reasoning retry";
  const failure = {
    name: "Chat Completions API with tool calling",
    httpStatus: 0,
    curlStatus: 0,
    message: failureMessage,
    body: "",
  };
  return {
    ok: false,
    message: `${failure.name}: ${failure.message}`,
    failures: [failure],
  };
}

function requestAuth(
  rawUrl: string,
  apiKey: string,
  options: OpenAiValidationOptions,
): { url: string; headers: Record<string, string> } {
  const url = new URL(rawUrl);
  const headers = Object.fromEntries(
    parseOpenAiLikeExtraHeaders(options.extraHeaders).map(({ name, value }) => [name, value]),
  );
  if (options.authMode === "query-param") {
    if (apiKey) url.searchParams.set("key", apiKey);
    return { url: url.toString(), headers };
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return { url: url.toString(), headers };
}

function streamingEventTypes(body: string): Set<string> {
  const events = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^event:\s*(.+)$/i.exec(line.trim());
    if (match) events.add(match[1].trim());
  }
  return events;
}

async function waitForRetry(ms: number): Promise<void> {
  if (process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorDetails(error: unknown): { error_code: string; error_message: string } {
  const value = error as NodeJS.ErrnoException;
  const message = error instanceof Error ? error.message : String(error);
  return {
    error_code: value?.code ?? "unknown",
    error_message: message.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]").slice(0, 256),
  };
}

async function requestWithHttpRetry(
  name: string,
  request: () => Promise<CurlProbeResult>,
  retryTransientHttp = true,
): Promise<CurlProbeResult> {
  return retryUntilAsync(
    async (attempt) => {
      const result = await request();
      addTraceEvent("probe_result", {
        attempt,
        ok: result.ok,
        http_status: result.httpStatus,
        curl_status: result.curlStatus,
      });
      return result;
    },
    {
      accept: (result) =>
        !retryTransientHttp ||
        result.curlStatus !== 0 ||
        !RETRIABLE_HTTP_PROBE_STATUSES.has(result.httpStatus),
      retryDelaysMs: RETRY_DELAYS_MS,
      onRetry: (result, delayMs) => {
        console.log(
          `  ${name} validation returned HTTP ${result.httpStatus}; retrying in ${Math.round(delayMs / 1000)}s...`,
        );
      },
      sleep: waitForRetry,
    },
  );
}

function shouldUseLegacyForModel(model: string): boolean {
  // Invalid state: the native session does not reproduce DeepSeek V4 Pro's
  // accepted late-first-token timeout result. The source of truth remains the
  // specialized streaming Chat Completions path in onboard-probes.ts, which
  // owns its payload, extended timeout, warning, and validated:false result.
  // Trying native first would add a long duplicate request before curl fallback
  // and could turn that accepted warning into a validation failure. The
  // "keeps DeepSeek V4 Pro on its specialized legacy streaming probe" test
  // locks direct legacy dispatch without native DNS. Remove this exception once
  // both transports share the streaming timeout-continuation helper and return
  // the same validation result.
  return isDeepSeekV4ProModel(model);
}

export async function probeOpenAiLikeEndpointWithValidationSession(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: OpenAiValidationOptions,
  deps: OpenAiValidationSessionDeps,
): Promise<OpenAiValidationResult> {
  if (shouldUseLegacyForModel(model)) {
    addTraceEvent("validation_transport_fallback", { reason: "special_streaming_model" });
    return deps.legacyProbe(endpointUrl, model, apiKey, options);
  }
  // Custom-endpoint SSRF preflight pins approved addresses through curl's
  // reviewed --resolve boundary. This #6661 migration fallback is bounded to
  // the native-session rollout: remove it once the native transport can enforce
  // the exact preflight address set and the caller-level rebinding test passes
  // with legacyProbe unavailable.
  if (
    (options.pinnedAddresses && options.pinnedAddresses.length > 0) ||
    options.trustedPrivateCapability
  ) {
    addTraceEvent("validation_transport_fallback", { reason: "preflight_address_pinning" });
    return deps.legacyProbe(endpointUrl, model, apiKey, options);
  }

  const session = await createValidationSession(endpointUrl, {
    ...deps.sessionOptions,
    pinnedAddresses: options.pinnedAddresses ?? deps.sessionOptions?.pinnedAddresses,
  });
  if (!session) return deps.legacyProbe(endpointUrl, model, apiKey, options);

  const baseUrl = endpointUrl.replace(/\/+$/, "");
  // Preserve curl diagnostics during the #6661 migration only. Remove this
  // replay once native proxy, CA, streaming, and terminal-failure parity is
  // complete and the public-helper migration tests pass without legacyProbe.
  const nativeFailureFallback = async (reason: string): Promise<OpenAiValidationResult> => {
    addTraceEvent("validation_transport_fallback", { reason });
    session.close();
    return deps.legacyProbe(endpointUrl, model, apiKey, options);
  };
  let retriedReasoningTruncation = false;
  let retriedToolReadiness = false;

  try {
    if (!options.skipResponsesProbe) {
      const auth = requestAuth(`${baseUrl}/responses`, apiKey, options);
      const responses = await withTraceSpan(
        "nemoclaw.inference.validation_probe",
        { probe_name: "Responses API", api: "openai-responses" },
        () =>
          requestWithHttpRetry("Responses API", () =>
            session.request({
              ...auth,
              body: responsesPayload(model, options.requireResponsesToolCalling === true),
              timeoutMs: deps.getResponsesTimeoutMs(options),
            }),
          ),
      );
      if (responses.curlStatus !== 0) return nativeFailureFallback("native_responses_failure");
      const responsesSemanticallyValid =
        responses.ok &&
        (options.requireResponsesToolCalling !== true || deps.hasResponsesToolCall(responses.body));
      if (responsesSemanticallyValid) {
        if (options.probeStreaming === true) {
          const streamResult = await session.request({
            ...auth,
            body: responsesPayload(model, false, true),
            // Cap the streaming probe deadline, mirroring the curl path. See #7792.
            timeoutMs: Math.min(
              deps.getResponsesTimeoutMs(options),
              STREAMING_EVENT_PROBE_MAX_SECONDS * 1000,
            ),
          });
          const events = streamingEventTypes(streamResult.body);
          if (streamResult.curlStatus !== 0 && streamResult.curlStatus !== 28) {
            return nativeFailureFallback("native_streaming_failure");
          }
          // Match onboard-probes.ts: a successful Responses payload without
          // response.output_text.delta falls through to Chat Completions. This
          // duplicate can be removed once both transports share event parsing.
          if (!events.has("response.output_text.delta")) {
            console.log(
              "  ℹ Responses API streaming response is missing required event: response.output_text.delta",
            );
          } else {
            return { ok: true, api: "openai-responses", label: "Responses API" };
          }
        } else {
          return { ok: true, api: "openai-responses", label: "Responses API" };
        }
      }
    }

    const auth = requestAuth(`${baseUrl}/chat/completions`, apiKey, options);
    const requireToolCall = options.requireChatCompletionsToolCalling === true;
    const chat = await withTraceSpan(
      "nemoclaw.inference.validation_probe",
      { probe_name: "Chat Completions API", api: "openai-completions" },
      async () => {
        const requestChat = (
          maxTokens = STRICT_TOOL_PROBE_INITIAL_TOKENS,
          retryTransientHttp = true,
          timeoutMultiplier = 1,
        ) =>
          requestWithHttpRetry(
            "Chat Completions API",
            () =>
              session.request({
                ...auth,
                body: requireToolCall
                  ? chatToolPayload(model, maxTokens)
                  : JSON.stringify(deps.getChatPayload(model, options)),
                timeoutMs: deps.getChatTimeoutMs(model, options) * timeoutMultiplier,
              }),
            retryTransientHttp,
          );
        const retryReasoningOnly = async (
          candidate: CurlProbeResult,
        ): Promise<CurlProbeResult | null> => {
          if (!isReasoningOnlyLengthResponse(candidate.body)) return null;
          let laddered = candidate;
          let exhaustedTokens = STRICT_TOOL_PROBE_INITIAL_TOKENS;
          for (const retryTokens of STRICT_TOOL_PROBE_RETRY_TOKEN_LADDER) {
            if (!laddered.ok || !isReasoningOnlyLengthResponse(laddered.body)) break;
            retriedReasoningTruncation = true;
            console.log(strictToolProbeReasoningRetryMessage(exhaustedTokens, retryTokens));
            addTraceEvent("tool_call_reasoning_retry", {
              initial_max_tokens: exhaustedTokens,
              retry_max_tokens: retryTokens,
            });
            // The final rung generates up to 4096 tokens; give it the doubled
            // deadline so a slow reasoning model does not time out instead of
            // finishing the larger response.
            laddered = await requestChat(
              retryTokens,
              false,
              retryTokens === STRICT_TOOL_PROBE_RETRY_TOKEN_LADDER.at(-1) ? 2 : 1,
            );
            exhaustedTokens = retryTokens;
          }
          return laddered;
        };
        let result = await requestChat();
        if (!requireToolCall || !result.ok) return result;
        const initialReasoningRetry = await retryReasoningOnly(result);
        if (initialReasoningRetry) return initialReasoningRetry;
        for (const delayMs of RETRY_DELAYS_MS) {
          if (
            options.retryChatCompletionsToolReadiness !== true ||
            result.httpStatus !== 200 ||
            deps.hasChatCompletionsToolCall(result.body) ||
            deps.hasChatCompletionsToolCallLeak(result.body)
          ) {
            break;
          }
          retriedToolReadiness = true;
          console.log(
            `  Chat Completions API validation did not return a structured tool call; retrying in ${Math.round(delayMs / 1000)}s...`,
          );
          addTraceEvent("tool_call_readiness_retry", { delay_ms: delayMs });
          await waitForRetry(delayMs);
          result = await requestChat(STRICT_TOOL_PROBE_INITIAL_TOKENS, false);
          if (!result.ok) break;
          const reasoningRetry = await retryReasoningOnly(result);
          if (reasoningRetry) return reasoningRetry;
        }
        return result;
      },
    );
    if (chat.curlStatus !== 0) {
      return retriedReasoningTruncation
        ? failedChatValidation(chat, chat.message)
        : nativeFailureFallback("native_chat_failure");
    }
    if (!chat.ok) {
      return retriedReasoningTruncation
        ? failedChatValidation(chat, chat.message)
        : nativeFailureFallback("native_terminal_http_failure");
    }
    if (requireToolCall) {
      if (!deps.hasChatCompletionsToolCall(chat.body)) {
        const leaked = deps.hasChatCompletionsToolCallLeak(chat.body);
        if (retriedReasoningTruncation || retriedToolReadiness) {
          return failedChatToolCall(chat, leaked);
        }
        return nativeFailureFallback(
          leaked ? "native_chat_tool_call_leak" : "native_chat_tool_call_missing",
        );
      }
    }
    return { ok: true, api: "openai-completions", label: "Chat Completions API" };
  } catch (error) {
    addTraceEvent("validation_transport_error", {
      reason: "native_unexpected_failure",
      ...safeErrorDetails(error),
    });
    return retriedReasoningTruncation
      ? failedChatValidationAfterReasoningRetry()
      : nativeFailureFallback("native_unexpected_failure");
  } finally {
    session.close();
  }
}
