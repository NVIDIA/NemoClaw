// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type OpenAiChatCapabilityInput = {
  endpointUrl: string;
  model: string;
  authMode?: "bearer" | "query-param";
  requireChatCompletionsToolCalling?: boolean;
  extraHeaders?: readonly string[];
  pinnedAddresses?: readonly string[];
};

function capabilityKey(input: OpenAiChatCapabilityInput): string | null {
  // Query strings, embedded URL credentials, and custom headers can carry
  // credentials. Do not retain either those values or a derived identifier.
  if (input.extraHeaders?.length || input.pinnedAddresses?.length) return null;

  let endpoint: URL;
  try {
    endpoint = new URL(input.endpointUrl);
  } catch {
    return null;
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    return null;
  }

  const model = input.model.trim();
  if (!model || model !== input.model) return null;
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return JSON.stringify({
    endpoint: endpoint.toString(),
    authMode: input.authMode ?? "bearer",
    model,
    requireChatCompletionsToolCalling: input.requireChatCompletionsToolCalling === true,
  });
}

/**
 * One onboarding invocation may validate a selected Chat Completions route and
 * then immediately run the same host-side smoke check. This cache is strictly
 * in-memory, one-shot, and refuses credential-bearing or pinned paths.
 */
export class OnboardInferenceCapabilityCache {
  readonly #entries = new Set<string>();

  rememberCompletedOpenAiChat(input: OpenAiChatCapabilityInput): boolean {
    const key = capabilityKey(input);
    if (!key) return false;
    this.#entries.add(key);
    return true;
  }

  takeCompletedOpenAiChat(input: OpenAiChatCapabilityInput): boolean {
    const key = capabilityKey(input);
    if (!key || !this.#entries.has(key)) return false;
    this.#entries.delete(key);
    return true;
  }

  invalidate(): void {
    this.#entries.clear();
  }
}
