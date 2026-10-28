// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const TELEMETRY_PROVIDER_PROFILES = [
  "nvidia",
  "openai",
  "anthropic",
  "google-gemini",
  "openrouter",
  "hermes",
  "ollama",
  "vllm",
  "llama-cpp",
  "compatible-endpoint",
  "custom",
  "unknown",
] as const;
export const MODEL_SELECTION_SOURCES = [
  "product_catalog",
  "provider_catalog",
  "custom",
  "local",
  "unknown",
] as const;
export const GPU_STATES = [
  "not_configured",
  "configured_unverified",
  "verified",
  "failed",
  "unknown",
] as const;
export const MESSAGING_CHANNELS = [
  "telegram",
  "discord",
  "wechat",
  "slack",
  "whatsapp",
  "teams",
  "googlechat",
  "other",
] as const;
const PROVIDERS: Readonly<Record<string, string>> = {
  "nvidia-prod": "nvidia",
  "nvidia-nim": "nvidia",
  "nvidia-router": "nvidia",
  "openai-api": "openai",
  "anthropic-prod": "anthropic",
  "gemini-api": "google-gemini",
  "openrouter-api": "openrouter",
  "hermes-provider": "hermes",
  "ollama-local": "ollama",
  "vllm-local": "vllm",
  "llama-cpp-local": "llama-cpp",
  "compatible-endpoint": "compatible-endpoint",
  "compatible-anthropic-endpoint": "compatible-endpoint",
};
/** Reject accessors and exotic objects before projecting any sandbox-controlled value. */
export function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    Object.hasOwn(descriptor, "value"),
  )
    ? (value as Record<string, unknown>)
    : null;
}

export function classifyTelemetryProvider(value: unknown): string {
  return typeof value === "string" && value !== "" ? (PROVIDERS[value] ?? "custom") : "unknown";
}
