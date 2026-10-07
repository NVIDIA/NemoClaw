// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dataRecord,
  MODEL_SELECTION_SOURCES,
  POLICY_TIER_CATEGORIES,
  TELEMETRY_API_FAMILIES,
  TELEMETRY_PROVIDER_PROFILES,
  classifyTelemetryProvider,
} from "./values";
import type { TelemetryModelAssignment } from "./event";

export interface AppliedPolicySelection {
  readonly schemaVersion: 1;
  readonly source: "verified_selection";
  readonly tier: (typeof POLICY_TIER_CATEGORIES)[number];
}
export interface ModelSelectionProvenance {
  readonly schemaVersion: 1;
  /** Private binding values stay in local state and never reach the telemetry record. */
  readonly model: string;
  readonly provider: string;
  readonly providerProfile: (typeof TELEMETRY_PROVIDER_PROFILES)[number];
  readonly modelSource: (typeof MODEL_SELECTION_SOURCES)[number];
  readonly apiFamily: (typeof TELEMETRY_API_FAMILIES)[number];
  readonly binding?: "gateway_route" | "native_configuration";
}

/** Private native-slot binding; only the source category is projected into an event. */
export interface ModelAssignmentSelection {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly assignment: TelemetryModelAssignment;
  readonly reference: string;
  readonly modelSource: ModelSelectionProvenance["modelSource"];
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = dataRecord(value);
  return record &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
    ? record
    : null;
}
export function readModelAssignmentSelection(value: unknown): ModelAssignmentSelection | null {
  const record = closed(value, [
    "schemaVersion",
    "agentId",
    "assignment",
    "reference",
    "modelSource",
  ]);
  return record?.schemaVersion === 1 &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0 &&
    record.agentId.length <= 128 &&
    typeof record.reference === "string" &&
    record.reference.length > 0 &&
    record.reference.length <= 1024 &&
    typeof record.assignment === "string" &&
    ["primary", "override", "fallback", "subagent"].includes(record.assignment) &&
    MODEL_SELECTION_SOURCES.some((source) => source === record.modelSource)
    ? (record as unknown as ModelAssignmentSelection)
    : null;
}
export function readAppliedPolicySelection(value: unknown): AppliedPolicySelection | null {
  const record = closed(value, ["schemaVersion", "source", "tier"]);
  const tier = POLICY_TIER_CATEGORIES.find((item) => item === record?.tier);
  return record?.schemaVersion === 1 && record.source === "verified_selection" && tier
    ? { schemaVersion: 1, source: "verified_selection", tier }
    : null;
}
export function readModelSelectionProvenance(value: unknown): ModelSelectionProvenance | null {
  const hasBinding = Object.hasOwn(dataRecord(value) ?? {}, "binding");
  const record = closed(value, [
    "schemaVersion",
    "model",
    "provider",
    "providerProfile",
    "modelSource",
    "apiFamily",
    ...(hasBinding ? ["binding"] : []),
  ]);
  const binding = hasBinding ? record?.binding : "gateway_route";
  const providerProfile = TELEMETRY_PROVIDER_PROFILES.find(
    (item) => item === record?.providerProfile,
  );
  const modelSource = MODEL_SELECTION_SOURCES.find((item) => item === record?.modelSource);
  const apiFamily = TELEMETRY_API_FAMILIES.find((item) => item === record?.apiFamily);
  return record?.schemaVersion === 1 &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    record.model.length <= 1024 &&
    typeof record.provider === "string" &&
    record.provider.length > 0 &&
    record.provider.length <= 1024 &&
    providerProfile &&
    modelSource &&
    apiFamily &&
    (binding === "gateway_route" || binding === "native_configuration")
    ? {
        schemaVersion: 1,
        model: record.model,
        provider: record.provider,
        providerProfile,
        modelSource,
        apiFamily,
        binding,
      }
    : null;
}

/** Called only at a proved selection's durable commit; endpoint data stays private. */
export function selectedModelProvenance(input: {
  model?: string | null;
  provider?: string | null;
  endpointUrl?: string | null;
  preferredInferenceApi?: string | null;
  modelSource?: ModelSelectionProvenance["modelSource"];
  binding?: ModelSelectionProvenance["binding"];
}): ModelSelectionProvenance | undefined {
  if (!input.model || !input.provider) return undefined;
  let providerProfile = classifyTelemetryProvider(
    input.provider,
  ) as ModelSelectionProvenance["providerProfile"];
  try {
    const endpoint = new URL(input.endpointUrl ?? "");
    if (
      input.provider === "compatible-endpoint" &&
      endpoint.protocol === "https:" &&
      endpoint.hostname === "inference-api.nvidia.com" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      !endpoint.search &&
      !endpoint.hash &&
      /^\/v1\/?$/.test(endpoint.pathname)
    )
      providerProfile = "nvidia";
  } catch {
    /* Built-in provider authority does not require a custom endpoint. */
  }
  return {
    schemaVersion: 1,
    model: input.model,
    provider: input.provider,
    providerProfile,
    modelSource: input.modelSource ?? "unknown",
    apiFamily:
      TELEMETRY_API_FAMILIES.find((item) => item === input.preferredInferenceApi) ?? "unknown",
    ...(input.binding ? { binding: input.binding } : {}),
  };
}
