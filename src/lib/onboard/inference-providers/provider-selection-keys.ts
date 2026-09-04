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

const PERSISTED_PROVIDER_SELECTION_KEYS: Readonly<Record<string, string>> = {
  "nvidia-router": "routed",
  "ollama-local": "ollama",
  "vllm-local": "vllm",
  // This legacy name identifies NVIDIA Endpoints, not Local NVIDIA NIM.
  "nvidia-nim": "build",
};

export type RemoteProviderConfigEntryLike = { providerName?: string };

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
  remoteProviderConfig: Readonly<Record<string, RemoteProviderConfigEntryLike>> = {},
): string | null {
  const name = String(value ?? "").trim();
  if (!name) return null;
  // Local NIM and standalone vLLM both persist as vllm-local. Only the
  // owner-only NIM container record distinguishes the excluded NIM route.
  if (name === "vllm-local") return options.hasNimContainer ? "nim-local" : "vllm";
  const localOrLegacy = PERSISTED_PROVIDER_SELECTION_KEYS[name];
  if (localOrLegacy) return localOrLegacy;
  for (const [key, config] of Object.entries(remoteProviderConfig)) {
    if (config.providerName === name) return normalizeNonInteractiveProviderKey(key);
  }
  return normalizeNonInteractiveProviderKey(name);
}
