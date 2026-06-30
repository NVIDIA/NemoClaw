// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/json-types";

function isPolicyObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This package-local implementation and the separately published ESM runner's
// equivalent are kept in behavioral parity by package-contract coverage. A
// cross-root import would either violate both TypeScript rootDir boundaries or
// make one published package depend on generated dist output.
export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(policies).filter(([name]) => !name.startsWith("_provider_")),
  );
}

export function stripProviderComposedPolicies(policy: string): string {
  try {
    const parsed = YAML.parse(policy);
    if (!isPolicyObject(parsed) || !isPolicyObject(parsed.network_policies)) return policy;
    const filtered = withoutProviderComposedPolicies(parsed.network_policies);
    if (Object.keys(filtered).length === Object.keys(parsed.network_policies).length) return policy;
    return YAML.stringify({ ...parsed, network_policies: filtered });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot filter provider-composed policy entries from invalid YAML: ${detail}`);
  }
}
