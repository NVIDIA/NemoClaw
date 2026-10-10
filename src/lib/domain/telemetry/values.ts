// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const AGENT_HARNESS_IDS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
  "other",
  "unknown",
] as const;
export const TELEMETRY_MODEL_IDS = [
  "Qwen/Qwen3.6-27B-FP8",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-ultra",
  "deepseek-ai/DeepSeek-V4-Flash",
  "nvidia/qwen/qwen3.6-27b",
  "nvidia/deepseek-ai/deepseek-v4-flash",
  "other",
  "unknown",
] as const;
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
export const TELEMETRY_API_FAMILIES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "unknown",
] as const;
export const MODEL_SELECTION_SOURCES = [
  "product_catalog",
  "provider_catalog",
  "custom",
  "local",
  "unknown",
] as const;
export const COMPUTE_DRIVERS = ["docker", "podman", "kubernetes", "other", "unknown"] as const;
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
export const POLICY_TIER_CATEGORIES = ["restricted", "balanced", "open", "personal"] as const;
export const SANDBOX_OPERATING_SYSTEMS = ["linux", "windows", "other", "unknown"] as const;
export const MANAGED_AGENT_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  openclaw: ["2026.9.2"],
  hermes: ["0.21.3"],
  "langchain-deepagents-code": ["0.1.55"],
};
export const TELEMETRY_MODEL_KEYS: Readonly<Record<string, string>> = {
  "Qwen/Qwen3.6-27B-FP8": "qwen3_6_27b_fp8",
  "nvidia/nemotron-3-ultra-550b-a55b": "nemotron3_ultra_550b_a55b",
  "nvidia/nvidia/nemotron-3-ultra": "nemotron3_ultra",
  "deepseek-ai/DeepSeek-V4-Flash": "deepseek_v4_flash",
  "nvidia/qwen/qwen3.6-27b": "qwen3_6_27b",
  "nvidia/deepseek-ai/deepseek-v4-flash": "deepseek_v4_flash",
};
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
