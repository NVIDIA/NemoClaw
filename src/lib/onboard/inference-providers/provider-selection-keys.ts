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

export const NON_INTERACTIVE_PROVIDER_VALID_VALUES = `Valid values: ${Array.from(
  NON_INTERACTIVE_PROVIDER_KEYS,
  (key) => (key === "hermesProvider" ? "hermes-provider" : key),
).join(", ")}`;

/** Gateway provider names declared by built-in provider selection keys. */
export const REMOTE_PROVIDER_NAMES_BY_SELECTION_KEY: Readonly<Record<string, string>> = {
  build: "nvidia-prod",
  openrouter: "openrouter-api",
  openai: "openai-api",
  anthropic: "anthropic-prod",
  anthropicCompatible: "compatible-anthropic-endpoint",
  gemini: "gemini-api",
  hermesProvider: "hermes-provider",
  custom: "compatible-endpoint",
  "llama-cpp": "llama-cpp-local",
};

const PERSISTED_PROVIDER_SELECTION_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(REMOTE_PROVIDER_NAMES_BY_SELECTION_KEY).map(([key, name]) => [name, key]),
  ),
  "nvidia-router": "routed",
  "ollama-local": "ollama",
  "vllm-local": "vllm",
  // This legacy name identifies NVIDIA Endpoints, not Local NVIDIA NIM.
  "nvidia-nim": "build",
};

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

/** Resolve the provider representation persisted in an onboarding session. */
export function persistedProviderNameToSelectionKey(
  value: string | null | undefined,
  options: { hasNimContainer?: boolean } = {},
): string | null {
  const name = String(value ?? "").trim();
  if (!name) return null;
  // Local NIM and standalone vLLM both persist as vllm-local. Only the
  // owner-only NIM container record distinguishes the excluded NIM route.
  if (name === "vllm-local") return options.hasNimContainer ? "nim-local" : "vllm";
  return PERSISTED_PROVIDER_SELECTION_KEYS[name] ?? normalizeNonInteractiveProviderKey(name);
}

/** True only for a recognized persisted provider route that N1x permits. */
export function isN1xOnboardingRecordedProvider(
  value: string | null | undefined,
  options: { hasNimContainer?: boolean } = {},
): boolean {
  const selection = persistedProviderNameToSelectionKey(value, options);
  return selection !== null && selection !== "nim-local";
}
