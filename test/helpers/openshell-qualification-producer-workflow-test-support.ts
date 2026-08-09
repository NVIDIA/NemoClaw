// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("test fixture value is not an object");
  }
  return value as JsonRecord;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("test fixture value is not an array");
  return value;
}

export function requiredStep(workflowSteps: JsonRecord[], index: number): JsonRecord {
  const selected = workflowSteps[index];
  if (!selected) throw new Error(`missing test fixture step ${index}`);
  return selected;
}
