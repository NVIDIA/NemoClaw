// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PhaseResult, RunContext, RunPlan, RunPlanPhase } from "../types.ts";
import { EnvironmentOrchestrator } from "./environment.ts";
import { OnboardingOrchestrator } from "./onboarding.ts";
import { RuntimeOrchestrator } from "./runtime.ts";

interface PhaseRunner {
  run(ctx: RunContext, phase: RunPlanPhase, priorResults?: PhaseResult[]): Promise<PhaseResult>;
}

export interface ScenarioRunnerDeps {
  environment?: PhaseRunner;
  onboarding?: PhaseRunner;
  runtime?: PhaseRunner;
}

export class ScenarioRunner {
  private readonly environment: PhaseRunner;
  private readonly onboarding: PhaseRunner;
  private readonly runtime: PhaseRunner;

  constructor(deps: ScenarioRunnerDeps = {}) {
    this.environment = deps.environment ?? new EnvironmentOrchestrator();
    this.onboarding = deps.onboarding ?? new OnboardingOrchestrator();
    this.runtime = deps.runtime ?? new RuntimeOrchestrator();
  }

  async run(ctx: RunContext, plan: RunPlan): Promise<PhaseResult[]> {
    const results: PhaseResult[] = [];
    for (const phase of plan.phases) {
      if (phase.name === "environment") {
        results.push(await this.environment.run(ctx, phase, results));
        continue;
      }
      if (phase.name === "onboarding") {
        results.push(await this.onboarding.run(ctx, phase, results));
        continue;
      }
      if (phase.name === "runtime") {
        results.push(await this.runtime.run(ctx, phase, results));
        continue;
      }
      throw new Error(`Unsupported phase: ${String(phase.name)}`);
    }
    return results;
  }
}
