// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CheckpointDecision } from "./onboard-checkpoint-types";

const UNSET: CheckpointDecision<never> = { kind: "unset" };
const DECLINED: CheckpointDecision<never> = { kind: "declined" };

export function decisionUnset<T>(): CheckpointDecision<T> {
  return UNSET;
}

export function decisionDeclined<T>(): CheckpointDecision<T> {
  return DECLINED;
}

export function decisionSelected<T>(value: T): CheckpointDecision<T> {
  return { kind: "selected", value };
}

export function isDecisionUnset<T>(decision: CheckpointDecision<T>): boolean {
  return decision.kind === "unset";
}

export function isDecisionDeclined<T>(decision: CheckpointDecision<T>): boolean {
  return decision.kind === "declined";
}

export function isDecisionSelected<T>(
  decision: CheckpointDecision<T>,
): decision is { kind: "selected"; value: T } {
  return decision.kind === "selected";
}

export function decisionValue<T>(decision: CheckpointDecision<T>): T | null {
  return decision.kind === "selected" ? decision.value : null;
}

export function decisionsEqual<T>(
  a: CheckpointDecision<T>,
  b: CheckpointDecision<T>,
  valuesEqual: (x: T, y: T) => boolean = Object.is,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "selected" && b.kind === "selected") return valuesEqual(a.value, b.value);
  return true;
}

export function decisionFromLegacyNullable<Raw, Value>(
  completed: boolean,
  rawValue: Raw | null | undefined,
  parse: (raw: Raw) => Value | null,
): CheckpointDecision<Value> {
  if (!completed) return decisionUnset();
  if (rawValue === null || rawValue === undefined) return decisionDeclined();
  const parsed = parse(rawValue);
  return parsed === null ? decisionDeclined() : decisionSelected(parsed);
}

export function parseCheckpointDecision<Value>(
  raw: unknown,
  parseValue: (value: unknown) => Value | null,
): CheckpointDecision<Value> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "unset") return decisionUnset();
  if (kind === "declined") return decisionDeclined();
  if (kind === "selected") {
    const parsed = parseValue((raw as { value?: unknown }).value);
    return parsed === null ? null : decisionSelected(parsed);
  }
  return null;
}
