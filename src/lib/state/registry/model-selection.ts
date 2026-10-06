// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  normalizeInferenceSelection,
  type InferenceSelectionInput,
} from "../../inference/selection";
import {
  parseModelSelectionProvenance,
  type ModelSelectionProvenance,
} from "../../domain/telemetry/provenance";

/** Private snapshot binding: no route identity is duplicated in the receipt. */
export interface ModelSelectionSnapshot {
  readonly schemaVersion: 1;
  readonly routeFingerprint: string;
  readonly selection: ModelSelectionProvenance;
}

function fingerprint(input: InferenceSelectionInput): string {
  const route = normalizeInferenceSelection(input);
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.provider,
        route.model,
        route.endpointUrl,
        route.credentialEnv,
        route.preferredInferenceApi,
        route.nimContainer,
      ]),
    )
    .digest("hex");
}

export function parseModelSelectionSnapshot(value: unknown): ModelSelectionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 3 ||
    !["schemaVersion", "routeFingerprint", "selection"].every(
      (key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"),
    )
  )
    return null;
  const record = value as Record<string, unknown>;
  const selection = parseModelSelectionProvenance(record.selection);
  if (
    record.schemaVersion !== 1 ||
    typeof record.routeFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.routeFingerprint) ||
    !selection
  )
    return null;
  return Object.freeze({ schemaVersion: 1, routeFingerprint: record.routeFingerprint, selection });
}

export function captureModelSelectionSnapshot(
  input: InferenceSelectionInput,
): ModelSelectionSnapshot | undefined {
  const selection = parseModelSelectionProvenance(input?.modelSelectionProvenance);
  const route = normalizeInferenceSelection(input);
  if (!selection || !route.provider || !route.model) return undefined;
  return Object.freeze({ schemaVersion: 1, routeFingerprint: fingerprint(route), selection });
}

export function matchingModelSelectionSnapshot(
  value: unknown,
  target: InferenceSelectionInput,
): ModelSelectionProvenance | undefined {
  const snapshot = parseModelSelectionSnapshot(value);
  return snapshot?.routeFingerprint === fingerprint(target) ? snapshot.selection : undefined;
}
