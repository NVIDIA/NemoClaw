// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../nemoclaw/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: nemoclaw/shared/openshell-policy-boundary.cjs
// stableBoundary: source tests and both published runtimes load this exact
// package-root module. Keep this typed wrapper implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
