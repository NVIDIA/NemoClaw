// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Recursively order mapping keys by fixed UTF-16 code units. */
export function sortCanonicalMappings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalMappings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortCanonicalMappings(child)]),
  );
}
