// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NON_INTERACTIVE_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  cloud: "build",
  nim: "nim-local",
  vllm: "vllm",
  "open-router": "openrouter",
  openrouterai: "openrouter",
  anthropiccompatible: "anthropicCompatible",
  hermes: "hermesProvider",
  "hermes-provider": "hermesProvider",
  hermesprovider: "hermesProvider",
  nous: "hermesProvider",
  "nous-portal": "hermesProvider",
};

export const NON_INTERACTIVE_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "build",
  "openrouter",
  "openai",
  "anthropic",
  "anthropicCompatible",
  "gemini",
  "hermesProvider",
  "ollama",
  "llama-cpp",
  "install-llama-cpp",
  "custom",
  "nim-local",
  "vllm",
  "routed",
  "install-vllm",
  "install-ollama",
  "install-windows-ollama",
  "start-windows-ollama",
]);

export function normalizeNonInteractiveProviderKey(
  value: string | null | undefined,
): string | null {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const normalized = NON_INTERACTIVE_PROVIDER_ALIASES[key] ?? key;
  return NON_INTERACTIVE_PROVIDER_KEYS.has(normalized) ? normalized : null;
}

/** True only for a recognized provider route that N1x onboarding permits. */
export function isN1xOnboardingProviderKey(value: string | null | undefined): boolean {
  const normalized = normalizeNonInteractiveProviderKey(value);
  return normalized !== null && normalized !== "nim-local";
}
