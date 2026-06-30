// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/json-types";

function isPolicyObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// invalidState: OpenShell `policy get --base` unexpectedly includes a
// provider-composed `_provider_*` entry that `policy set` must never receive.
// sourceBoundary: OpenShell owns base-policy composition; NemoClaw owns every
// read-modify-write payload it submits. The upstream formatter cannot be fixed
// here, so filter defensively until the supported OpenShell contract guarantees
// these entries are absent. Regression: policy-openshell-072-roundtrip.test.ts.
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
  } catch {
    return policy;
  }
}
