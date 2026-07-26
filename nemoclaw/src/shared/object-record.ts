// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type UnknownRecord = Record<string, unknown>;

/** Narrow any non-null, non-array object to a string-keyed record. */
export function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow objects whose prototype is Object.prototype or null. */
export function isPlainObject(value: unknown): value is UnknownRecord {
  if (!isObjectRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
