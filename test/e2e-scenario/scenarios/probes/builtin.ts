// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { diagnosticsProbe } from "./diagnostics.ts";
import { docsValidationProbe } from "./docs-validation.ts";
import { injectionBlockedProbe } from "./injection-blocked.ts";
import { networkPolicyProbe } from "./network-policy.ts";
import { shieldsConfigProbe } from "./shields-config.ts";
import { lookupProbe, registerProbe } from "./registry.ts";

/**
 * Register all built-in probes. Idempotent: re-importing this module
 * (e.g. through a different entry point) is a no-op once the probes
 * are already in place.
 *
 * Ownership boundary:
 *   - Built-in probes here implement the cross-scenario contract that
 *     the typed registry already references by name (see
 *     scenarios/assertions/registry.ts).
 *   - Scenario-specific probes (if any) belong in a per-scenario
 *     module that calls `registerProbe()` directly.
 *
 * Security probes (shieldsConfigProbe, networkPolicyProbe,
 * injectionBlockedProbe) are marked `required: true` in
 * scenarios/assertions/registry.ts. With the implementations
 * registered below, the orchestrator runs them and fails the phase
 * on real assertion violations — not on a missing implementation.
 */
const BUILTIN_PROBES = {
  diagnosticsProbe,
  docsValidationProbe,
  shieldsConfigProbe,
  networkPolicyProbe,
  injectionBlockedProbe,
} as const;

export function registerBuiltinProbes(): void {
  for (const [name, fn] of Object.entries(BUILTIN_PROBES)) {
    if (lookupProbe(name) === undefined) {
      registerProbe(name, fn);
    }
  }
}
