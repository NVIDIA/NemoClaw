// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

function policyMap(content: string): Record<string, unknown> {
  const policies = YAML.parse(content)?.network_policies;
  return policies && typeof policies === "object" && !Array.isArray(policies) ? policies : {};
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
