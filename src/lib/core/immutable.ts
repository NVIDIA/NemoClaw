// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function deepFreezeOwnedValue<T>(value: T, seen: WeakSet<object>): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) deepFreezeOwnedValue(descriptor.value, seen);
  }
  return Object.freeze(value);
}

/**
 * Take ownership of structured data before exposing it across an adapter
 * boundary. The clone prevents retained caller aliases and the recursive
 * freeze prevents a provider from changing nested authority after validation.
 */
export function cloneAndDeepFreeze<T>(value: T): T {
  return deepFreezeOwnedValue(structuredClone(value), new WeakSet<object>());
}
