// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${String(index)}]`));
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-serializable`);

  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new Error(`${path}.${key} is undefined`);
    output[key] = canonicalize(child, `${path}.${key}`);
  }
  return output;
}

export function canonicalManagedInferenceJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "catalog"));
}

export function managedInferenceDigest(value: unknown): string {
  return `sha256:${managedInferenceHexDigest(value)}`;
}

export function managedInferenceHexDigest(value: unknown): string {
  return createHash("sha256").update(canonicalManagedInferenceJson(value)).digest("hex");
}

export function managedInferenceTextDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function immutableManagedInferenceCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalManagedInferenceJson(value)) as T);
}
