// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const FIELD_STATUSES = ["reported", "unapproved", "not_observed"] as const;
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
export const SANDBOX_OPERATING_SYSTEMS = ["linux", "windows", "other", "unknown"] as const;
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

type FieldStatus = (typeof FIELD_STATUSES)[number];
export interface TelemetryConfiguration {
  agentHarnessId: (typeof AGENT_HARNESS_IDS)[number];
  agentHarnessStatus: FieldStatus;
  modelId: (typeof TELEMETRY_MODEL_IDS)[number];
  modelStatus: FieldStatus;
  providerProfile: (typeof TELEMETRY_PROVIDER_PROFILES)[number];
  apiFamily: (typeof TELEMETRY_API_FAMILIES)[number];
  sandboxOS: (typeof SANDBOX_OPERATING_SYSTEMS)[number];
  sandboxOSStatus: FieldStatus;
  computeDriver: (typeof COMPUTE_DRIVERS)[number];
  gpuState: (typeof GPU_STATES)[number];
  webSearchEnabled: boolean | "unknown";
  observabilityEnabled: boolean | "unknown";
  imageOwnership: "managed" | "custom" | "unknown";
  policyTier: (typeof POLICY_TIER_CATEGORIES)[number] | null;
  policyTierStatus: "reported" | "not_persisted" | "not_observed" | "invalid";
  configuredMessagingChannels: readonly (typeof MESSAGING_CHANNELS)[number][];
  messagingStatus: "reported" | "not_observed" | "invalid";
}

export const UNKNOWN_TELEMETRY_CONFIGURATION: Readonly<TelemetryConfiguration> = Object.freeze({
  agentHarnessId: "unknown",
  agentHarnessStatus: "not_observed",
  modelId: "unknown",
  modelStatus: "not_observed",
  providerProfile: "unknown",
  apiFamily: "unknown",
  sandboxOS: "unknown",
  sandboxOSStatus: "not_observed",
  computeDriver: "unknown",
  gpuState: "unknown",
  webSearchEnabled: "unknown",
  observabilityEnabled: "unknown",
  imageOwnership: "unknown",
  policyTier: null,
  policyTierStatus: "not_persisted",
  configuredMessagingChannels: Object.freeze([]),
  messagingStatus: "not_observed",
});

function contains<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((item) => item === value);
}

function objectWithExactKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
    ? record
    : null;
}

function fieldStatusMatches(value: string, status: FieldStatus): boolean {
  if (value === "unknown") return status === "not_observed";
  if (value === "other") return status === "unapproved";
  return status === "reported";
}

export function parseTelemetryConfiguration(value: unknown): TelemetryConfiguration | null {
  const record = objectWithExactKeys(value, Object.keys(UNKNOWN_TELEMETRY_CONFIGURATION));
  if (!record) return null;
  const {
    agentHarnessId,
    agentHarnessStatus,
    modelId,
    modelStatus,
    providerProfile,
    apiFamily,
    sandboxOS,
    sandboxOSStatus,
    computeDriver,
    gpuState,
    webSearchEnabled,
    observabilityEnabled,
    imageOwnership,
    policyTier,
    policyTierStatus,
    configuredMessagingChannels,
    messagingStatus,
  } = record;
  const channels =
    Array.isArray(configuredMessagingChannels) &&
    configuredMessagingChannels.length <= MESSAGING_CHANNELS.length
      ? Array.from(
          { length: configuredMessagingChannels.length },
          (_, index) => configuredMessagingChannels[index],
        )
      : null;
  if (
    !contains(AGENT_HARNESS_IDS, agentHarnessId) ||
    !contains(FIELD_STATUSES, agentHarnessStatus) ||
    !contains(TELEMETRY_MODEL_IDS, modelId) ||
    !contains(FIELD_STATUSES, modelStatus) ||
    !contains(TELEMETRY_PROVIDER_PROFILES, providerProfile) ||
    !contains(TELEMETRY_API_FAMILIES, apiFamily) ||
    !contains(SANDBOX_OPERATING_SYSTEMS, sandboxOS) ||
    !contains(FIELD_STATUSES, sandboxOSStatus) ||
    !contains(COMPUTE_DRIVERS, computeDriver) ||
    !contains(GPU_STATES, gpuState) ||
    !(typeof webSearchEnabled === "boolean" || webSearchEnabled === "unknown") ||
    !(typeof observabilityEnabled === "boolean" || observabilityEnabled === "unknown") ||
    !contains(["managed", "custom", "unknown"], imageOwnership) ||
    !(policyTier === null || contains(POLICY_TIER_CATEGORIES, policyTier)) ||
    !contains(["reported", "not_persisted", "not_observed", "invalid"], policyTierStatus) ||
    !contains(["reported", "not_observed", "invalid"], messagingStatus) ||
    !channels ||
    !channels.every((channel) => contains(MESSAGING_CHANNELS, channel)) ||
    new Set(channels).size !== channels.length
  )
    return null;
  if (
    !fieldStatusMatches(agentHarnessId, agentHarnessStatus) ||
    !fieldStatusMatches(modelId, modelStatus) ||
    !fieldStatusMatches(sandboxOS, sandboxOSStatus) ||
    (messagingStatus !== "reported" && channels.length !== 0) ||
    (policyTierStatus === "reported" ? policyTier === null : policyTier !== null)
  )
    return null;
  return Object.freeze({
    agentHarnessId,
    agentHarnessStatus,
    modelId,
    modelStatus,
    providerProfile,
    apiFamily,
    sandboxOS,
    sandboxOSStatus,
    computeDriver,
    gpuState,
    webSearchEnabled,
    observabilityEnabled,
    imageOwnership,
    policyTier,
    policyTierStatus,
    configuredMessagingChannels: Object.freeze(
      channels,
    ) as TelemetryConfiguration["configuredMessagingChannels"],
    messagingStatus,
  });
}

export function classifyTelemetryAgent(
  value: unknown,
): Pick<TelemetryConfiguration, "agentHarnessId" | "agentHarnessStatus"> {
  if (typeof value !== "string" || value.trim().length === 0)
    return { agentHarnessId: "unknown", agentHarnessStatus: "not_observed" };
  if (value === "openclaw" || value === "hermes" || value === "langchain-deepagents-code")
    return { agentHarnessId: value, agentHarnessStatus: "reported" };
  return { agentHarnessId: "other", agentHarnessStatus: "unapproved" };
}

export function classifyTelemetryModel(
  value: unknown,
): Pick<TelemetryConfiguration, "modelId" | "modelStatus"> {
  if (typeof value !== "string" || value.trim().length === 0)
    return { modelId: "unknown", modelStatus: "not_observed" };
  if (contains(TELEMETRY_MODEL_IDS, value) && value !== "other" && value !== "unknown")
    return { modelId: value, modelStatus: "reported" };
  return { modelId: "other", modelStatus: "unapproved" };
}

const PROVIDER_CATEGORIES: Readonly<Record<string, TelemetryConfiguration["providerProfile"]>> = {
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
export function classifyTelemetryProvider(
  value: unknown,
): TelemetryConfiguration["providerProfile"] {
  if (typeof value !== "string" || value.trim().length === 0) return "unknown";
  return Object.hasOwn(PROVIDER_CATEGORIES, value) ? PROVIDER_CATEGORIES[value] : "custom";
}
export function classifyTelemetryApi(value: unknown): TelemetryConfiguration["apiFamily"] {
  return contains(TELEMETRY_API_FAMILIES, value) ? value : "unknown";
}

const CPU_ARCHITECTURES: Readonly<Record<string, string>> = {
  arm: "arm",
  arm64: "aarch64",
  ia32: "x86",
  loong64: "loong64",
  mips: "mips",
  mipsel: "mipsel",
  ppc: "ppc",
  ppc64: "ppc64",
  riscv64: "riscv64",
  s390: "s390",
  s390x: "s390x",
  x64: "x86_64",
};
export function normalizeTelemetryArchitecture(value: unknown): {
  cpuArchitecture: string;
  hostArch: string;
} {
  if (typeof value !== "string" || !Object.hasOwn(CPU_ARCHITECTURES, value))
    return { cpuArchitecture: "undefined", hostArch: "unknown" };
  const architecture = CPU_ARCHITECTURES[value];
  return { cpuArchitecture: architecture, hostArch: value };
}
export function classifyTelemetryHostOS(
  value: unknown,
): "linux" | "macos" | "windows" | "other" | "unknown" {
  if (value === "linux") return "linux";
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  if (contains(["aix", "freebsd", "openbsd", "sunos", "android"], value)) return "other";
  return "unknown";
}

export interface TelemetryLocation {
  countryCode: string | null;
  countryName: string | null;
  regionName: string | null;
  cityName: string | null;
  locationSource: "none" | "approved_network_origin" | "approved_deployment";
  locationStatus: "not_configured" | "unavailable" | "partial" | "reported";
  locationPrecision: "none" | "country" | "region" | "city";
  locationObservedAt: string | null;
}
export const EMPTY_TELEMETRY_LOCATION: Readonly<TelemetryLocation> = Object.freeze({
  countryCode: null,
  countryName: null,
  regionName: null,
  cityName: null,
  locationSource: "none",
  locationStatus: "not_configured",
  locationPrecision: "none",
  locationObservedAt: null,
});
function publicLocationLabel(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 96 &&
      value === value.trim() &&
      /^[\p{L}\p{M}\p{N} .,'()’-]+$/u.test(value) &&
      !/[0-9]+(?:\.[0-9]+){3}/.test(value) &&
      !/-?[0-9]{1,2}\.[0-9]+[ ,]+-?[0-9]{1,3}\.[0-9]+/.test(value))
  );
}
function observationTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
export function parseTelemetryLocation(value: unknown): TelemetryLocation | null {
  const record = objectWithExactKeys(value, Object.keys(EMPTY_TELEMETRY_LOCATION));
  if (!record) return null;
  const {
    countryCode,
    countryName,
    regionName,
    cityName,
    locationSource,
    locationStatus,
    locationPrecision,
    locationObservedAt,
  } = record;
  if (
    !(
      countryCode === null ||
      (typeof countryCode === "string" &&
        countryCode.length === 2 &&
        /^[A-Z]{2}$/.test(countryCode))
    ) ||
    !publicLocationLabel(countryName) ||
    !publicLocationLabel(regionName) ||
    !publicLocationLabel(cityName) ||
    !contains(["none", "approved_network_origin", "approved_deployment"], locationSource) ||
    !contains(["not_configured", "unavailable", "partial", "reported"], locationStatus) ||
    !contains(["none", "country", "region", "city"], locationPrecision) ||
    !(locationObservedAt === null || observationTimestamp(locationObservedAt))
  )
    return null;
  const empty =
    countryCode === null && countryName === null && regionName === null && cityName === null;
  if (locationStatus === "not_configured" || locationStatus === "unavailable") {
    if (
      !empty ||
      locationPrecision !== "none" ||
      locationObservedAt !== null ||
      (locationStatus === "not_configured" && locationSource !== "none")
    )
      return null;
  } else {
    if (
      locationSource === "none" ||
      countryCode === null ||
      countryName === null ||
      locationObservedAt === null
    )
      return null;
    if (
      locationPrecision !==
      (cityName !== null ? "city" : regionName !== null ? "region" : "country")
    )
      return null;
    if (locationStatus === "reported" && (regionName === null || cityName === null)) return null;
    if (locationStatus === "partial" && regionName !== null && cityName !== null) return null;
  }
  return Object.freeze({
    countryCode,
    countryName,
    regionName,
    cityName,
    locationSource,
    locationStatus,
    locationPrecision,
    locationObservedAt,
  });
}
