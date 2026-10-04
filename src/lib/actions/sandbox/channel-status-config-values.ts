// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingSerializableValue } from "../../messaging/manifest";

export function configInputDetail(value: MessagingSerializableValue | undefined): string {
  if (value === undefined || value === null) return "not set";
  return formatConfigValue(value);
}

export function formatConfigValue(value: MessagingSerializableValue): string {
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map(formatConfigValue).join(", ");
  }
  return JSON.stringify(value);
}

export function configValuesEqual(
  expected: MessagingSerializableValue | undefined,
  actual: MessagingSerializableValue | undefined,
): boolean {
  if (expected === undefined || expected === null) return actual === undefined || actual === null;
  if (actual === undefined || actual === null) return false;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const expectedList = listConfigValues(expected);
    const actualList = listConfigValues(actual);
    return (
      expectedList.length === actualList.length &&
      expectedList.every((value, index) => value === actualList[index])
    );
  }
  const expectedBoolean = booleanConfigValue(expected);
  const actualBoolean = booleanConfigValue(actual);
  if (expectedBoolean !== null && actualBoolean !== null) return expectedBoolean === actualBoolean;
  return formatConfigValue(expected) === formatConfigValue(actual);
}

export function listConfigValues(value: MessagingSerializableValue): string[] {
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0)
    .sort();
}

export function booleanConfigValue(value: MessagingSerializableValue): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}
