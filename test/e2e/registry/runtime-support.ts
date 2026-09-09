// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  e2eExecutionTitle,
  type E2eExecutionMetadata,
  validateE2eExecutionMetadata,
} from "../../../tools/e2e/execution-coverage.mts";
import type { TargetDefinition } from "./types.ts";

const SUPPORTED_PLATFORMS = new Set(["ubuntu-local"]);
const SUPPORTED_INSTALLS = new Set(["repo-current"]);
const SUPPORTED_RUNTIMES = new Set(["docker-running", "managed-runtime-running"]);
const SUPPORTED_ONBOARDING = new Set([
  "cloud-openclaw",
  "cloud-openclaw-policy-custom-missing-presets",
  "cloud-langchain-deepagents-code",
]);
const SUPPORTED_POLICY_TIERS = new Set(["balanced", "open", "personal"]);
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
    if (environment.policyTier && !SUPPORTED_POLICY_TIERS.has(environment.policyTier)) {
      reasons.push(`policyTier '${environment.policyTier}' is not wired for live fixtures`);
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

export function liveTargetExecutionCoverage(
  target: TargetDefinition,
  support = liveTargetSupport(target),
): E2eExecutionMetadata {
  if (support.supported && !target.executionCoverage) {
    throw new Error(
      `Executable typed E2E target ${target.id} requires execution coverage metadata`,
    );
  }
  return validateE2eExecutionMetadata(
    target.executionCoverage ?? {
      agentRuntime: "unresolved",
      observableOutcome: "unresolved",
      environmentOrInferenceEndpoint: "unresolved",
      unresolvedReason: "This typed registry declaration has no executable owner",
    },
    `Typed E2E target ${target.id}`,
  );
}

/**
 * The stable target ID remains the workflow selector. The semantic tuple
 * supplies the human-visible Vitest title without changing target identity.
 */
export function liveTargetTestTitle(
  target: TargetDefinition,
  support = liveTargetSupport(target),
): string {
  return `${target.id}: ${e2eExecutionTitle(liveTargetExecutionCoverage(target, support))}`;
}
