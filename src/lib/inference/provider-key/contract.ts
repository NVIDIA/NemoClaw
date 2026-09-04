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
