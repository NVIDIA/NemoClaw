// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { POLICY_TIER_CATEGORIES, TELEMETRY_API_FAMILIES } from "./dimensions";

export const RECORDED_POLICY_TIERS = POLICY_TIER_CATEGORIES;
export type RecordedPolicyTier = (typeof RECORDED_POLICY_TIERS)[number];
export const MODEL_SELECTION_SOURCES = [
  "product_catalog",
  "provider_catalog",
  "custom",
  "local",
  "unknown",
] as const;
export interface AppliedPolicySelection {
  readonly schemaVersion: 1;
  readonly source: "verified_selection";
  readonly tier: RecordedPolicyTier;
}
export interface ModelSelectionProvenance {
  readonly schemaVersion: 1;
  readonly modelSource: (typeof MODEL_SELECTION_SOURCES)[number];
  readonly apiFamily: (typeof TELEMETRY_API_FAMILIES)[number];
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== keys.length ||
    !keys.every(
      (key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"),
    )
  )
    return null;
  return value as Record<string, unknown>;
}
export function parseAppliedPolicySelection(value: unknown): AppliedPolicySelection | null {
  const record = closedRecord(value, ["schemaVersion", "source", "tier"]);
  if (!record || record.schemaVersion !== 1 || record.source !== "verified_selection") return null;
  const tier = RECORDED_POLICY_TIERS.find((item) => item === record.tier);
  return tier ? Object.freeze({ schemaVersion: 1, source: "verified_selection", tier }) : null;
}
export function parseModelSelectionProvenance(value: unknown): ModelSelectionProvenance | null {
  const record = closedRecord(value, ["schemaVersion", "modelSource", "apiFamily"]);
  if (!record || record.schemaVersion !== 1) return null;
  const modelSource = MODEL_SELECTION_SOURCES.find((item) => item === record.modelSource);
  const apiFamily = TELEMETRY_API_FAMILIES.find((item) => item === record.apiFamily);
  return modelSource && apiFamily
    ? Object.freeze({ schemaVersion: 1, modelSource, apiFamily })
    : null;
}
