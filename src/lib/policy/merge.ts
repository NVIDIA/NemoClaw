// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// CommonJS wrapper is compiled. Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
