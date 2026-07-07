// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TargetDefinition } from "./types.ts";

const SUPPORTED_PLATFORMS = new Set(["ubuntu-local"]);
const SUPPORTED_INSTALLS = new Set(["repo-current"]);
const SUPPORTED_RUNTIMES = new Set(["docker-running"]);
const SUPPORTED_ONBOARDING = new Set(["cloud-openclaw", "cloud-langchain-deepagents-code"]);
// Lifecycle profiles wired into the live Vitest driver. A profile is
// supported only after both (a) `LifecyclePhaseFixture.simulate(profile)`
// dispatches it, and (b) at least one expected-state declares the post-
// lifecycle host invariants the fixture creates. New profiles must add
// the dispatcher branch and an expected-state in the same change set.
const SUPPORTED_LIFECYCLES = new Set(["post-reboot-recovery", "dcode-rebuild-invalid-credential"]);

export interface LiveTargetSupport {
  supported: boolean;
  reasons: string[];
  pendingRuntimeSuites: string[];
}

/**
 * Canonical name under which a target is registered with Vitest in the
 * live registry-targets test file. The workflow filters by exact ID via
 * `-t "^${TARGET_ID}$"`, so both supported and unsupported targets MUST
 * be registered under this exact name. Skip reasons are surfaced via the
 * job log instead of the test name suffix.
 */
export function liveTargetTestName(target: TargetDefinition): string {
  return target.id;
}

export function liveTargetSupport(target: TargetDefinition): LiveTargetSupport {
  const reasons: string[] = [];
  const environment = target.environment;
  if (!environment) {
    reasons.push("missing environment");
  } else {
    if (!SUPPORTED_PLATFORMS.has(environment.platform)) {
      reasons.push(`platform '${environment.platform}' is not wired for live fixtures`);
    }
    if (!SUPPORTED_INSTALLS.has(environment.install)) {
      reasons.push(`install '${environment.install}' is not wired for live fixtures`);
    }
    if (!SUPPORTED_RUNTIMES.has(environment.runtime)) {
      reasons.push(`runtime '${environment.runtime}' is not wired for live fixtures`);
    }
    if (!SUPPORTED_ONBOARDING.has(environment.onboarding)) {
      reasons.push(`onboarding '${environment.onboarding}' is not wired for live fixtures`);
    }
    if (environment.lifecycle && !SUPPORTED_LIFECYCLES.has(environment.lifecycle)) {
      reasons.push(`lifecycle '${environment.lifecycle}' is not wired for live fixtures`);
    }
  }
  if (!target.expectedStateId) {
    reasons.push("missing expectedStateId");
  }

  return {
    supported: reasons.length === 0,
    reasons,
    pendingRuntimeSuites: target.suiteIds ?? [],
  };
}
