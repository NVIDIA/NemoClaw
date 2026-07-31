// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deeply freeze a value that has already been cloned and validated into local
 * ownership. This is an exposure boundary, not a sanitizer: callers must not
 * pass shared mutable inputs or unvalidated host objects.
 */
export function deepFreezeOwned<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);

  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) {
      deepFreezeOwned(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}
