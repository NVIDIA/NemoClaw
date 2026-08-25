// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves how an inference probe states its reply budget: the OpenAI-compatible
 * Chat Completions field name for a given model, and the smallest reply budget
 * every probe may request.
 *
 * OpenAI's GPT-5 family and the reasoning-model series (o1/o3/o4) reject the
 * legacy `max_tokens` parameter on `/chat/completions` and require
 * `max_completion_tokens` instead — Azure OpenAI surfaces the same requirement
 * (HTTP 400: "Unsupported parameter: 'max_tokens' is not supported with this
 * model. Use 'max_completion_tokens' instead."). Both the host-side onboarding
 * probe and the in-sandbox smoke check must agree on the field name, so they
 * share this single resolver rather than each carrying their own model list.
 */

/**
 * Smallest reply budget an inference probe may request.
 *
 * Probes only need to read back a short acknowledgement, but the budget is a
 * value the endpoint validates, not just a ceiling NemoClaw applies. Some
 * supported hosted endpoints reject a budget below 16 with HTTP 400 even when
 * discovery succeeds and normal inference works, so a smaller value turns a
 * valid endpoint, model, and credential combination into a failed onboarding,
 * health, or rebuild preflight check (#7939). The Anthropic Messages probe
 * already requests 16; every other probe shares that floor here rather than
 * carrying its own literal.
 */
export const MIN_PROBE_REPLY_TOKENS = 16;

// Gemini 2.5 can spend part of the output budget on reasoning before it emits
// visible content. Match the established compatible-endpoint smoke budget so
// a healthy route has room to return the requested acknowledgement (#10260).
export const GEMINI_PROBE_REPLY_TOKENS = 256;

// Matched by prefix rather than exact id: Azure OpenAI deployments append
// version/suffix segments (e.g. "gpt-5.4", "gpt-5.4-turbo") and callers may or
// may not include a provider prefix ("azure/gpt-5.4").
const MAX_COMPLETION_TOKENS_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

/**
 * Whether the model requires `max_completion_tokens` in place of `max_tokens`.
 */
export function requiresMaxCompletionTokensField(model: string | null | undefined): boolean {
  const normalized = String(model || "").toLowerCase();
  const bare = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return MAX_COMPLETION_TOKENS_MODEL_PREFIXES.some(
    (prefix) => bare === prefix || bare.startsWith(`${prefix}.`) || bare.startsWith(`${prefix}-`),
  );
}

/**
 * Returns the Chat Completions reply-budget field name for the model:
 * `max_completion_tokens` for GPT-5/o-series, otherwise `max_tokens`.
 */
export function resolveMaxTokensField(
  model: string | null | undefined,
): "max_tokens" | "max_completion_tokens" {
  return requiresMaxCompletionTokensField(model) ? "max_completion_tokens" : "max_tokens";
}
