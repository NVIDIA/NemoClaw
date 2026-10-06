// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TelemetryConfiguration } from "./dimensions";
import {
  COMPUTE_DRIVERS,
  GPU_STATES,
  MESSAGING_CHANNELS,
  POLICY_TIER_CATEGORIES,
  TELEMETRY_API_FAMILIES,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_PROVIDER_PROFILES,
} from "./dimensions";
import { MODEL_SELECTION_SOURCES } from "./provenance";

export const OBSERVATION_OPERATIONS = [
  "onboard",
  "inference_set",
  "destroy",
  "clone",
  "restore",
  "rebuild",
  "recovery",
  "messaging_add",
  "messaging_remove",
] as const;
export type ObservationOperation = (typeof OBSERVATION_OPERATIONS)[number];
export const MAX_TELEMETRY_BATCH_EVENTS = 4_096;
export const AGENT_RUNTIMES = ["openclaw", "hermes", "langchain-deepagents-code", "other"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
// Product-owned public version keys, reviewed with the corresponding agent manifest pins.
export const MANAGED_AGENT_VERSIONS = {
  openclaw: ["2026.9.2"],
  hermes: ["0.21.3"],
  "langchain-deepagents-code": ["0.1.55"],
} as const;
export const MODEL_SOURCES = MODEL_SELECTION_SOURCES;
export const TELEMETRY_MODEL_KEYS = {
  "Qwen/Qwen3.6-27B-FP8": "qwen3_6_27b_fp8",
  "nvidia/nemotron-3-ultra-550b-a55b": "nemotron3_ultra_550b_a55b",
  "nvidia/nvidia/nemotron-3-ultra": "nemotron3_ultra",
  "deepseek-ai/DeepSeek-V4-Flash": "deepseek_v4_flash",
} as const;

export function knownTelemetryModelKey(modelId: TelemetryConfiguration["modelId"]): string {
  if (modelId === "other" || modelId === "unknown") return modelId;
  return TELEMETRY_MODEL_KEYS[modelId];
}

export const SANDBOX_SIGNALS = {
  compute_driver: COMPUTE_DRIVERS,
  gpu_state: GPU_STATES,
  web_search_enabled: ["true", "false", "unknown"],
  observability_enabled: ["true", "false", "unknown"],
  image_ownership: ["managed", "custom", "unknown"],
  policy_tier: [...POLICY_TIER_CATEGORIES, "unknown"],
} as const;
export type SandboxSignal = keyof typeof SANDBOX_SIGNALS;

export interface SandboxCountObservedEvent {
  event: "nemoclaw_sandbox_count_observed";
  operation: ObservationOperation;
  count: number;
}
export interface AgentRuntimeObservedEvent {
  event: "nemoclaw_agent_runtime_observed";
  operation: ObservationOperation;
  agent_runtime: AgentRuntime;
  count: number;
}
export interface ManagedAgentVersionObservedEvent {
  event: "nemoclaw_managed_agent_version_observed";
  operation: ObservationOperation;
  agent_runtime: Exclude<AgentRuntime, "other">;
  managed_agent_version: string;
  count: number;
}
export interface HostConfigurationObservedEvent {
  event: "nemoclaw_configuration_observed";
  operation: ObservationOperation;
  scope: "host";
  signal: "host_platform";
  value: "linux" | "wsl" | "macos" | "other" | "unknown";
}
export interface ModelObservedEvent {
  event: "nemoclaw_model_observed";
  operation: ObservationOperation;
  model_source: (typeof MODEL_SOURCES)[number];
  known_model_key: string;
  modelId: TelemetryConfiguration["modelId"];
  provider_profile: TelemetryConfiguration["providerProfile"];
  api_family: TelemetryConfiguration["apiFamily"];
  count: number;
}
export interface MessagingObservedEvent {
  event: "nemoclaw_messaging_observed";
  operation: ObservationOperation;
  messaging_channel: (typeof MESSAGING_CHANNELS)[number];
  count: number;
}
export interface SandboxConfigurationObservedEvent {
  event: "nemoclaw_configuration_observed";
  operation: ObservationOperation;
  scope: "sandbox";
  signal: SandboxSignal;
  value: string;
  count: number;
}
export type AggregateTelemetryEvent =
  | SandboxCountObservedEvent
  | AgentRuntimeObservedEvent
  | ManagedAgentVersionObservedEvent
  | HostConfigurationObservedEvent
  | SandboxConfigurationObservedEvent
  | ModelObservedEvent
  | MessagingObservedEvent;

export function isObservationOperation(value: unknown): value is ObservationOperation {
  return OBSERVATION_OPERATIONS.some((operation) => operation === value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

function validCount(value: unknown, zero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (zero ? 0 : 1);
}

export function approvedManagedVersion(
  runtime: Exclude<AgentRuntime, "other">,
  value: unknown,
): string {
  return MANAGED_AGENT_VERSIONS[runtime].some((version) => version === value)
    ? String(value)
    : "other";
}

export function parseAggregateTelemetryEvent(value: unknown): AggregateTelemetryEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const {
    event,
    operation,
    count,
    agent_runtime: runtime,
    managed_agent_version: version,
    scope,
    signal,
    value: signalValue,
    model_source: modelSource,
    known_model_key: modelKey,
    modelId,
    provider_profile: providerProfile,
    api_family: apiFamily,
    messaging_channel: channel,
  } = record;
  if (!isObservationOperation(operation)) return null;
  switch (event) {
    case "nemoclaw_sandbox_count_observed":
      return exactKeys(record, ["event", "operation", "count"]) && validCount(count, true)
        ? Object.freeze({ event, operation, count })
        : null;
    case "nemoclaw_agent_runtime_observed":
      return exactKeys(record, ["event", "operation", "agent_runtime", "count"]) &&
        validCount(count) &&
        AGENT_RUNTIMES.some((item) => item === runtime)
        ? Object.freeze({ event, operation, agent_runtime: runtime as AgentRuntime, count })
        : null;
    case "nemoclaw_managed_agent_version_observed":
      if (
        !exactKeys(record, [
          "event",
          "operation",
          "agent_runtime",
          "managed_agent_version",
          "count",
        ]) ||
        !validCount(count) ||
        !AGENT_RUNTIMES.some((item) => item !== "other" && item === runtime)
      )
        return null;
      if (
        typeof version !== "string" ||
        approvedManagedVersion(runtime as Exclude<AgentRuntime, "other">, version) !== version
      )
        return null;
      return Object.freeze({
        event,
        operation,
        agent_runtime: runtime as Exclude<AgentRuntime, "other">,
        managed_agent_version: version,
        count,
      });
    case "nemoclaw_model_observed":
      if (
        !exactKeys(record, [
          "event",
          "operation",
          "model_source",
          "known_model_key",
          "modelId",
          "provider_profile",
          "api_family",
          "count",
        ]) ||
        !validCount(count)
      )
        return null;
      if (
        !MODEL_SOURCES.some((item) => item === modelSource) ||
        !TELEMETRY_MODEL_IDS.some((item) => item === modelId) ||
        !TELEMETRY_PROVIDER_PROFILES.some((item) => item === providerProfile) ||
        !TELEMETRY_API_FAMILIES.some((item) => item === apiFamily)
      )
        return null;
      if (knownTelemetryModelKey(modelId as TelemetryConfiguration["modelId"]) !== modelKey)
        return null;
      return Object.freeze({
        event,
        operation,
        model_source: modelSource as ModelObservedEvent["model_source"],
        known_model_key: modelKey as string,
        modelId: modelId as ModelObservedEvent["modelId"],
        provider_profile: providerProfile as ModelObservedEvent["provider_profile"],
        api_family: apiFamily as ModelObservedEvent["api_family"],
        count,
      });
    case "nemoclaw_messaging_observed":
      return exactKeys(record, ["event", "operation", "messaging_channel", "count"]) &&
        validCount(count) &&
        MESSAGING_CHANNELS.some((item) => item === channel)
        ? Object.freeze({
            event,
            operation,
            messaging_channel: channel as MessagingObservedEvent["messaging_channel"],
            count,
          })
        : null;
    case "nemoclaw_configuration_observed":
      if (scope === "host") {
        return exactKeys(record, ["event", "operation", "scope", "signal", "value"]) &&
          signal === "host_platform" &&
          ["linux", "wsl", "macos", "other", "unknown"].some((item) => item === signalValue)
          ? Object.freeze({
              event,
              operation,
              scope,
              signal,
              value: signalValue as HostConfigurationObservedEvent["value"],
            })
          : null;
      }
      if (
        scope !== "sandbox" ||
        !exactKeys(record, ["event", "operation", "scope", "signal", "value", "count"]) ||
        !validCount(count) ||
        typeof signal !== "string" ||
        !Object.hasOwn(SANDBOX_SIGNALS, signal)
      )
        return null;
      if (!SANDBOX_SIGNALS[signal as SandboxSignal].some((item) => item === signalValue))
        return null;
      return Object.freeze({
        event,
        operation,
        scope,
        signal: signal as SandboxSignal,
        value: signalValue as string,
        count,
      });
    default:
      return null;
  }
}

export function sandboxSignalValue(
  configuration: TelemetryConfiguration,
  signal: SandboxSignal,
): string {
  switch (signal) {
    case "compute_driver":
      return configuration.computeDriver;
    case "gpu_state":
      return configuration.gpuState;
    case "web_search_enabled":
      return String(configuration.webSearchEnabled);
    case "observability_enabled":
      return String(configuration.observabilityEnabled);
    case "image_ownership":
      return configuration.imageOwnership;
    case "policy_tier":
      return configuration.policyTier ?? "unknown";
  }
}
