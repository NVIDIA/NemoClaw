// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import type { TrustedPrivateEndpointCapability } from "../inference/endpoint-ssrf-preflight";

type OpenAiChatCapabilityInput = {
  endpointUrl: string;
  model: string;
  authMode?: "bearer" | "query-param";
  requireChatCompletionsToolCalling?: boolean;
  extraHeaders?: readonly string[];
  pinnedAddresses?: readonly string[];
  trustedPrivateCapability?: TrustedPrivateEndpointCapability;
};

function capabilityKey(input: OpenAiChatCapabilityInput): string | null {
  // Query strings, embedded URL credentials, and custom headers can carry
  // credentials. Do not retain either those values or a derived identifier.
  // Operator-trusted private endpoints must repeat the validation request because
  // their access depends on a non-forgeable capability at the curl boundary.
  if (input.extraHeaders?.length || input.trustedPrivateCapability) return null;

  const pinnedAddresses = [...new Set(input.pinnedAddresses ?? [])].sort();
  if (pinnedAddresses.some((address) => isIP(address) === 0)) return null;

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
    pinnedAddresses,
    requireChatCompletionsToolCalling: input.requireChatCompletionsToolCalling === true,
  });
}

/**
 * One onboarding invocation may validate a selected endpoint with a Chat
 * Completions request and would otherwise send the same host-side validation
 * request immediately. This cache is in-memory and one-shot. Public DNS-pinned
 * endpoints bind the exact approved IP address set into the receipt.
 * Credential-bearing inputs and operator-trusted private endpoints remain
 * non-cacheable.
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
