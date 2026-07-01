// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

function policyMap(content: string): Record<string, unknown> {
  const policies = YAML.parse(content)?.network_policies;
  return policies && typeof policies === "object" && !Array.isArray(policies) ? policies : {};
}

/** Return the first incoming policy key that is present but not explicitly owned. */
export function findUnownedExistingPolicyKey(
  currentPolicy: string,
  presetEntries: string,
  allowedExistingKeys: readonly string[],
): string | null {
  const current = policyMap(currentPolicy);
  const incoming = policyMap(`network_policies:\n${presetEntries}`);
  const allowed = new Set(allowedExistingKeys);
  return (
    Object.keys(incoming).find(
      (key) => Object.prototype.hasOwnProperty.call(current, key) && !allowed.has(key),
    ) ?? null
  );
}
