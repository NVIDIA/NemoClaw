// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenAiLikeExtraHeaders } from "../adapters/http/auth-config";
import type { CurlProbeResult } from "../adapters/http/probe";
import {
  createValidationSession,
  type ValidationSessionOptions,
} from "../adapters/http/validation-session";
import { addTraceEvent, withTraceSpan } from "../trace";
import { resolveMaxTokensField } from "./max-tokens-field";
import { isDeepSeekV4ProModel } from "./openai-probe-models";

const RETRIABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export interface OpenAiValidationOptions {
  authMode?: "bearer" | "query-param";
  extraHeaders?: readonly string[];
  requireResponsesToolCalling?: boolean;
  requireChatCompletionsToolCalling?: boolean;
  skipResponsesProbe?: boolean;
  probeStreaming?: boolean;
  isWsl?: boolean;
  pinnedAddresses?: readonly string[];
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
  getChatPayload(model: string): Record<string, unknown>;
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

function chatToolPayload(model: string): string {
  const maxTokensField = resolveMaxTokensField(model);
  return JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a tool-calling assistant. When tools are available and the user asks for an action, call a tool.",
      },
      {
        role: "user",
        content:
          "Send hello to the current session. Use the sessions_send tool and do not answer in plain text.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "sessions_send",
          description: "Send a message to the active chat session.",
          parameters: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "memory_search",
          description: "Search memory for relevant prior context.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Fetch a URL and summarize the result.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "required",
    // GPT-5/o-series models reject custom sampling temperatures. Keep the
    // deterministic setting for models that still use the legacy field.
    ...(maxTokensField === "max_tokens" ? { temperature: 0 } : {}),
    [maxTokensField]: 256,
    stream: false,
  });
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
): Promise<CurlProbeResult> {
  let result = await request();
  let attempt = 1;
  addTraceEvent("probe_result", {
    attempt,
    ok: result.ok,
    http_status: result.httpStatus,
    curl_status: result.curlStatus,
  });
  for (const delayMs of RETRY_DELAYS_MS) {
    if (result.curlStatus !== 0 || !RETRIABLE_HTTP_STATUSES.has(result.httpStatus)) break;
    console.log(
      `  ${name} validation returned HTTP ${result.httpStatus}; retrying in ${Math.round(delayMs / 1000)}s...`,
    );
    await waitForRetry(delayMs);
    attempt += 1;
    result = await request();
    addTraceEvent("probe_result", {
      attempt,
      ok: result.ok,
      http_status: result.httpStatus,
      curl_status: result.curlStatus,
    });
  }
  return result;
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
  // reviewed --resolve boundary. Keep that security path authoritative until
  // native address pinning has equivalent end-to-end rebinding coverage.
  if (options.pinnedAddresses && options.pinnedAddresses.length > 0) {
    addTraceEvent("validation_transport_fallback", { reason: "preflight_address_pinning" });
    return deps.legacyProbe(endpointUrl, model, apiKey, options);
  }

  const session = await createValidationSession(endpointUrl, {
    ...deps.sessionOptions,
    pinnedAddresses: options.pinnedAddresses ?? deps.sessionOptions?.pinnedAddresses,
  });
  if (!session) return deps.legacyProbe(endpointUrl, model, apiKey, options);

  const baseUrl = endpointUrl.replace(/\/+$/, "");
  const nativeFailureFallback = async (reason: string): Promise<OpenAiValidationResult> => {
    addTraceEvent("validation_transport_fallback", { reason });
    session.close();
    return deps.legacyProbe(endpointUrl, model, apiKey, options);
  };

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
            timeoutMs: deps.getResponsesTimeoutMs(options),
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
    const chatBody =
      options.requireChatCompletionsToolCalling === true
        ? chatToolPayload(model)
        : JSON.stringify(deps.getChatPayload(model));
    const chat = await withTraceSpan(
      "nemoclaw.inference.validation_probe",
      { probe_name: "Chat Completions API", api: "openai-completions" },
      () =>
        requestWithHttpRetry("Chat Completions API", () =>
          session.request({
            ...auth,
            body: chatBody,
            timeoutMs: deps.getChatTimeoutMs(model, options),
          }),
        ),
    );
    if (chat.curlStatus !== 0) return nativeFailureFallback("native_chat_failure");
    if (!chat.ok) return nativeFailureFallback("native_terminal_http_failure");
    if (options.requireChatCompletionsToolCalling === true) {
      if (!deps.hasChatCompletionsToolCall(chat.body)) {
        return nativeFailureFallback(
          deps.hasChatCompletionsToolCallLeak(chat.body)
            ? "native_chat_tool_call_leak"
            : "native_chat_tool_call_missing",
        );
      }
    }
    return { ok: true, api: "openai-completions", label: "Chat Completions API" };
  } catch (error) {
    addTraceEvent("validation_transport_error", {
      reason: "native_unexpected_failure",
      ...safeErrorDetails(error),
    });
    return nativeFailureFallback("native_unexpected_failure");
  } finally {
    session.close();
  }
}
