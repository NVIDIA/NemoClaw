// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AdvisoryCheck } from "./types";

/** Creates an explicit, immutable advisory registry with globally unique IDs. */
export function defineAdvisoryRegistry<Context>(
  checks: readonly AdvisoryCheck<Context>[],
): readonly AdvisoryCheck<Context>[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`Duplicate advisory check id '${check.id}'.`);
    ids.add(check.id);
  }
  return Object.freeze([...checks]);
}

/** Checks are imported and registered explicitly as migration slices land (#3213). */
export const ADVISORY_CHECKS = defineAdvisoryRegistry<unknown>([]);
