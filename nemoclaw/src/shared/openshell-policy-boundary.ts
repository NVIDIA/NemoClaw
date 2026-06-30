// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// invalidState: OpenShell `policy get --base` unexpectedly includes a
// provider-composed `_provider_*` entry that `policy set` must never receive.
// sourceBoundary: OpenShell owns base-policy composition; NemoClaw owns every
// read-modify-write payload it submits.
// whyNotSourceFix: the upstream formatter cannot be fixed from this repository,
// so filter defensively until the supported contract guarantees their absence.
// regressionTest: the root policy round-trip and plugin runner policy tests.
// removalCondition: OpenShell's supported base-policy contract guarantees that
// provider-composed entries are absent from every mutation read.
export function withoutProviderComposedPolicies<T>(policies: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(policies).filter(([name]) => !name.startsWith("_provider_")),
  );
}
