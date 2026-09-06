// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MIN_PROBE_REPLY_TOKENS,
  resolveMaxTokensField,
  resolveProbeReplyTokens,
} from "./max-tokens-field";
import { loadManagedInferenceCatalog } from "./serving/catalog-loader";

export const STANDARD_NVIDIA_ENDPOINT_PROBE_POLICY =
  "nvidia.endpoint-validation.standard/v1";
export const EXTENDED_NVIDIA_ENDPOINT_PROBE_POLICY =
  "nvidia.endpoint-validation.extended/v1";

const NVIDIA_ENDPOINT_PROVIDERS = new Set(["nvidia-prod", "nvidia-nim"]);

export function usesNvidiaEndpointProbePayload(provider: unknown): boolean {
  return typeof provider === "string" && NVIDIA_ENDPOINT_PROVIDERS.has(provider);
}

/**
 * Resolve an explicit onboarding budget without replacing model-owned defaults
 * such as the DeepSeek V4 Pro 8192-token path.
 */
export function resolveOnboardingProbeReplyBudget(options: {
  replyBudget?: number;
  provider?: string | null;
}): number | undefined {
  if (options.replyBudget !== undefined) return options.replyBudget;
  return options.provider === "gemini-api"
    ? resolveProbeReplyTokens(options.provider)
    : undefined;
}

export function vllmProbePolicyForModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const matches = loadManagedInferenceCatalog().models.filter(({ spec }) =>
    [spec.id, spec.environmentValue, spec.servedName].some(
      (candidate) => candidate.toLowerCase() === normalized,
    ),
  );
  if (matches.length > 1) {
    throw new Error(`Managed vLLM catalog has ambiguous probe policies for model ${model}.`);
  }
  return matches[0]?.spec.probePolicyRef ?? STANDARD_NVIDIA_ENDPOINT_PROBE_POLICY;
}

export const STRICT_TOOL_PROBE_INITIAL_TOKENS = 256;
// Reasoning-heavy models can spend the whole output budget on their reasoning
// trace before emitting the structured tool call. nemotron-3-nano:30b fails at
// 1024 and passes at 4096 on the same host (#8714), so the retry escalates
// through this ladder instead of stopping at one larger budget.
export const STRICT_TOOL_PROBE_RETRY_TOKEN_LADDER: readonly number[] = [1024, 4096];

export function strictToolProbeReasoningRetryMessage(
  exhaustedTokens: number,
  retryTokens: number,
): string {
  return (
    `  Chat Completions tool-call validation exhausted ${exhaustedTokens} tokens in reasoning; ` +
    `retrying with a ${retryTokens}-token output budget...`
  );
}

export function isDeepSeekV4ProModel(model: unknown): boolean {
  return String(model || "").toLowerCase() === "deepseek-ai/deepseek-v4-pro";
}

export function isKimiK26Model(model: unknown): boolean {
  return String(model || "").toLowerCase() === "moonshotai/kimi-k2.6";
}

export function getChatCompletionsProbePayload(
  model: string,
  optionsOrReplyBudget:
    | { useNvidiaEndpointProbePayload?: boolean; replyBudget?: number }
    | number = {},
): Record<string, unknown> {
  const options =
    typeof optionsOrReplyBudget === "number"
      ? { replyBudget: optionsOrReplyBudget }
      : optionsOrReplyBudget;
  const maxTokensField = resolveMaxTokensField(model);
  const defaultReplyBudget = options.replyBudget ?? MIN_PROBE_REPLY_TOKENS;
  const payload = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    [maxTokensField]: defaultReplyBudget,
  };

  if (isDeepSeekV4ProModel(model)) {
    return {
      ...payload,
      temperature: 1,
      top_p: 0.95,
      [maxTokensField]: options.replyBudget ?? 8192,
      chat_template_kwargs: { thinking: false },
      stream: true,
    };
  }

  if (isKimiK26Model(model)) {
    return {
      ...payload,
      [maxTokensField]: defaultReplyBudget,
      chat_template_kwargs: { thinking: false },
    };
  }

  if (
    options.useNvidiaEndpointProbePayload === true &&
    model.toLowerCase() === "nvidia/nemotron-3-super-120b-a12b"
  ) {
    return {
      ...payload,
      temperature: 1,
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: false },
    };
  }

  return payload;
}

export function getChatCompletionsToolProbePayload(
  model: string,
  maxTokens = STRICT_TOOL_PROBE_INITIAL_TOKENS,
): Record<string, unknown> {
  const maxTokensField = resolveMaxTokensField(model);
  return {
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
    [maxTokensField]: maxTokens,
    stream: false,
  };
}

export function isReasoningOnlyLengthResponse(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const choice = (parsed as { choices?: unknown[] }).choices?.[0];
  if (!choice || typeof choice !== "object") return false;
  const typedChoice = choice as {
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
  };
  const message = typedChoice.message;
  if (typedChoice.finish_reason !== "length" || !message) return false;
  const reasoning = [message.reasoning_content, message.reasoning].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const contentIsEmpty =
    message.content == null ||
    (typeof message.content === "string" && message.content.trim().length === 0) ||
    (Array.isArray(message.content) && message.content.length === 0);
  const toolCallsAreEmpty =
    message.tool_calls == null ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length === 0);
  return Boolean(reasoning) && contentIsEmpty && toolCallsAreEmpty;
}
