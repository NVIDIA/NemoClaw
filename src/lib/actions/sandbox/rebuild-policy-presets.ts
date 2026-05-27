// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pruneDisabledMessagingPolicyPresets } from "../../onboard/messaging-policy-presets";
import type { CustomPolicyEntry } from "../../state/registry";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeRebuildCustomPolicies(value: unknown): CustomPolicyEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: CustomPolicyEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    const content = asString(record.content);
    if (!name || !content || seen.has(name)) continue;

    const sourcePath = asString(record.sourcePath);
    const appliedAt = asString(record.appliedAt);
    entries.push({
      name,
      content,
      ...(sourcePath ? { sourcePath } : {}),
      ...(appliedAt ? { appliedAt } : {}),
    });
    seen.add(name);
  }

  return entries;
}

export function resolveRebuildPolicyPresetNames(
  policyPresets: readonly string[] | null | undefined,
  customPolicies: readonly Pick<CustomPolicyEntry, "name">[],
  disabledChannels: readonly string[] | null | undefined,
): string[] {
  const names: string[] = [];
  for (const name of policyPresets || []) {
    if (typeof name === "string" && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  for (const entry of customPolicies) {
    if (entry.name && !names.includes(entry.name)) names.push(entry.name);
  }

  return pruneDisabledMessagingPolicyPresets(
    names,
    Array.isArray(disabledChannels) ? [...disabledChannels] : [],
  );
}

export function getRebuildCustomPolicy(
  customPolicies: readonly CustomPolicyEntry[],
  presetName: string,
): CustomPolicyEntry | null {
  return customPolicies.find((entry) => entry.name === presetName) || null;
}
