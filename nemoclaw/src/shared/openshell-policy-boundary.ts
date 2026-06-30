// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

// invalidState: OpenShell `policy get --base` unexpectedly includes a
// provider-composed `_provider_*` entry that `policy set` must never receive.
// sourceBoundary: OpenShell owns base-policy composition; NemoClaw owns every
// read-modify-write payload it submits.
// whyNotSourceFix: the upstream formatter cannot be fixed from this repository,
// so filter defensively until the supported contract guarantees their absence.
// regressionTest: the root policy round-trip and plugin runner policy tests.
// removalCondition: OpenShell's supported base-policy contract guarantees that
// provider-composed entries are absent from every mutation read.
// tracking: revalidate this guard at every stable OpenShell pin after 0.0.72.
export function withoutProviderComposedPolicies<T>(policies: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(policies).filter(([name]) => !name.startsWith("_provider_")),
  );
}

export function stripProviderComposedPolicies(policy: string): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(policy);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot filter provider-composed policy entries from invalid YAML: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return policy;
  const document = parsed as Record<string, unknown>;
  const networkPolicies = document.network_policies;
  if (
    typeof networkPolicies !== "object" ||
    networkPolicies === null ||
    Array.isArray(networkPolicies)
  ) {
    return policy;
  }
  return YAML.stringify({
    ...document,
    network_policies: withoutProviderComposedPolicies(networkPolicies as Record<string, unknown>),
  });
}
