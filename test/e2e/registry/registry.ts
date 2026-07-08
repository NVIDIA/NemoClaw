// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalTargets } from "./definitions/baseline.ts";
import type { TargetDefinition } from "./types.ts";

export const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const TARGET_ID_PATTERN_DESCRIPTION =
  "ASCII letters, digits, underscores, and hyphens, starting with a letter or digit";

export interface TargetRegistry {
  targets: TargetDefinition[];
  byId: Map<string, TargetDefinition>;
}

export function assertSafeTargetId(id: string, context = "Target ID"): void {
  if (!TARGET_ID_PATTERN.test(id)) {
    throw new Error(
      `${context} '${id}' is not safe for workflow regex filters or artifact paths; expected ${TARGET_ID_PATTERN_DESCRIPTION}.`,
    );
  }
}

export function buildTargetRegistry(targets: TargetDefinition[]): TargetRegistry {
  const byId = new Map<string, TargetDefinition>();
  const duplicates = new Set<string>();
  for (const target of targets) {
    assertSafeTargetId(target.id);
    if (byId.has(target.id)) {
      duplicates.add(target.id);
    }
    byId.set(target.id, target);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate target IDs: ${Array.from(duplicates).sort().join(", ")}`);
  }
  return { targets: [...targets], byId };
}

const registry = buildTargetRegistry(canonicalTargets());

export function listTargets(): TargetDefinition[] {
  return [...registry.targets].sort((a, b) => a.id.localeCompare(b.id));
}

export function getTarget(id: string): TargetDefinition | undefined {
  return registry.byId.get(id);
}

export function requireTargets(ids: string[]): TargetDefinition[] {
  const availableIds = listTargets().map((target) => target.id);
  const targets = ids.map((id) => {
    assertSafeTargetId(id, "Selected target ID");
    const found = getTarget(id);
    if (!found) {
      throw new Error(`Unknown target '${id}'. Available targets: ${availableIds.join(", ")}`);
    }
    return found;
  });
  return targets;
}
