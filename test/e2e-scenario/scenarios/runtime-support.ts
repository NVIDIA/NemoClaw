// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScenarioDefinition } from "./types.ts";

const SUPPORTED_PLATFORMS = new Set(["ubuntu-local"]);
const SUPPORTED_INSTALLS = new Set(["repo-current"]);
const SUPPORTED_RUNTIMES = new Set(["docker-running"]);
const SUPPORTED_ONBOARDING = new Set(["cloud-openclaw"]);

export interface LiveScenarioSupport {
  supported: boolean;
  reasons: string[];
  pendingRuntimeSuites: string[];
}

export function liveScenarioSupport(scenario: ScenarioDefinition): LiveScenarioSupport {
  const reasons: string[] = [];
  const environment = scenario.environment;
  if (!environment) {
    reasons.push("missing environment");
  } else {
    if (!SUPPORTED_PLATFORMS.has(environment.platform)) {
      reasons.push(`platform '${environment.platform}' is not wired for live Vitest fixtures`);
    }
    if (!SUPPORTED_INSTALLS.has(environment.install)) {
      reasons.push(`install '${environment.install}' is not wired for live Vitest fixtures`);
    }
    if (!SUPPORTED_RUNTIMES.has(environment.runtime)) {
      reasons.push(`runtime '${environment.runtime}' is not wired for live Vitest fixtures`);
    }
    if (!SUPPORTED_ONBOARDING.has(environment.onboarding)) {
      reasons.push(`onboarding '${environment.onboarding}' is not wired for live Vitest fixtures`);
    }
    if (environment.lifecycle) {
      reasons.push(`lifecycle '${environment.lifecycle}' is not wired for live Vitest fixtures`);
    }
  }
  if (!scenario.expectedStateId) {
    reasons.push("missing expectedStateId");
  }

  return {
    supported: reasons.length === 0,
    reasons,
    pendingRuntimeSuites: scenario.suiteIds ?? [],
  };
}
