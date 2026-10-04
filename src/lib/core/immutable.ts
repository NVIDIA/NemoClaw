// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function deepFreezeOwnedValue<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== "object" || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) deepFreezeOwnedValue(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function assertPlainData(value: unknown, seen: WeakSet<object>): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("cloneAndDeepFreeze accepts plain data only");
  }
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    throw new TypeError("cloneAndDeepFreeze does not accept stateful or binary objects");
  }

  const object = value as object;
  if (seen.has(object)) return;
  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("cloneAndDeepFreeze accepts plain objects and arrays only");
  }
  seen.add(object);

  for (const key of Reflect.ownKeys(object)) {
    if (Array.isArray(object) && key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError("cloneAndDeepFreeze does not accept symbol-keyed data");
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("cloneAndDeepFreeze accepts enumerable data properties only");
    }
    assertPlainData(descriptor.value, seen);
  }
}

/**
 * Take ownership of plain data before exposing it across an adapter boundary.
 *
 * Supported inputs are primitives, arrays, and plain objects composed only of
 * enumerable data properties. Stateful or executable values such as Map, Set,
 * Date, ArrayBuffer, typed arrays, Buffer, accessors, symbols, and functions
 * are rejected. The clone prevents retained caller aliases and the recursive
 * freeze prevents a provider from changing nested authority after validation.
 */
export function cloneAndDeepFreeze<T>(value: T): T {
  assertPlainData(value, new WeakSet<object>());
  return deepFreezeOwnedValue(structuredClone(value), new WeakSet<object>());
}
