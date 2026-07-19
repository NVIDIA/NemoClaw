// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

function policyMap(content: string): Record<string, unknown> {
  const policies = YAML.parse(content)?.network_policies;
  return policies && typeof policies === "object" && !Array.isArray(policies) ? policies : {};
}

/**
 * Return whether applying `presetContent` on top of `currentPolicy` would add
 * or change any network_policies key. False means the preset's declared
 * policies already match what is live, so disclosing "effective egress that
 * would be opened" would misrepresent a no-op mutation as new egress.
 */
export function presetIntroducesNewEgress(currentPolicy: string, presetContent: string): boolean {
  const current = policyMap(currentPolicy);
  const incoming = policyMap(presetContent);
  return Object.entries(incoming).some(([key, value]) => !isDeepStrictEqual(current[key], value));
}

/**
 * Return the first incoming key whose live value is not exactly the value the
 * caller previously proved it owned. A null expected document owns no keys.
 */
export function findUnexpectedExistingPolicyKey(
  currentPolicy: string,
  presetEntries: string,
  expectedPolicyContent: string | null,
): string | null {
  const current = policyMap(currentPolicy);
  const incoming = policyMap(`network_policies:\n${presetEntries}`);
  const expected = expectedPolicyContent === null ? {} : policyMap(expectedPolicyContent);
  return (
    Object.keys(incoming).find((key) => {
      const currentHasKey = Object.prototype.hasOwnProperty.call(current, key);
      if (expectedPolicyContent === null) return currentHasKey;
      return (
        !currentHasKey ||
        !Object.prototype.hasOwnProperty.call(expected, key) ||
        !isDeepStrictEqual(current[key], expected[key])
      );
    }) ?? null
  );
}
