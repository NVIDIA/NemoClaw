// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const PROVIDER_KEY_ROUTE_VALUES = new Set([
  "anthropic",
  "anthropiccompatible",
  "build",
  "cloud",
  "custom",
  "gemini",
  "hermes",
  "hermes-provider",
  "hermesprovider",
  "inference",
  "install-llama-cpp",
  "install-ollama",
  "install-vllm",
  "install-windows-ollama",
  "llama-cpp",
  "nim",
  "nim-local",
  "nous",
  "nous-portal",
  "ollama",
  "open-router",
  "openai",
  "openrouter",
  "openrouterai",
  "routed",
  "start-windows-ollama",
  "vllm",
]);

export function isProviderKeyCredentialCandidate(value: string | null | undefined): boolean {
  if (!value) return false;
  return !PROVIDER_KEY_ROUTE_VALUES.has(value.trim().toLowerCase());
}

export const MODEL_ROUTER_REMOVED_MESSAGE =
  "Model Router has been removed because llm-router is deprecated. Choose a supported inference provider for a new onboarding attempt. Use destroy or uninstall for existing router resources; no provider migration or cleanup was performed.";

/** Reject retired selections before callers acquire credentials or change resources. */
export function rejectRetiredModelRouter(provider: string | null | undefined): void {
  const normalized = provider?.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "routed" || normalized === "nvidia-router") {
    throw new Error(MODEL_ROUTER_REMOVED_MESSAGE);
  }
}

/** Retain old resource metadata for explicit cleanup instead of resuming it. */
export function rejectRetiredModelRouterSession(
  session:
    | {
        provider?: unknown;
        routerPid?: unknown;
        routerPort?: unknown;
        routerCredentialHash?: unknown;
      }
    | null
    | undefined,
): void {
  rejectRetiredModelRouter(typeof session?.provider === "string" ? session.provider : null);
  if (session?.routerPid || session?.routerPort || session?.routerCredentialHash) {
    throw new Error(MODEL_ROUTER_REMOVED_MESSAGE);
  }
}
