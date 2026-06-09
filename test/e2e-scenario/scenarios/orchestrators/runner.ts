// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { PhaseActionResult, PhaseResult, RunContext, RunPlan, RunPlanPhase } from "../types.ts";
import { seedContextEnv } from "./context.ts";
import { EnvironmentOrchestrator } from "./environment.ts";
import { LifecycleOrchestrator } from "./lifecycle.ts";
import { evaluateNegativeContract, negativeContractPhaseResult } from "./negative-matcher.ts";
import { OnboardingOrchestrator } from "./onboarding.ts";
import { RuntimeOrchestrator } from "./runtime.ts";
import { StateValidationOrchestrator } from "./state-validation.ts";

interface PhaseRunner {
  run(ctx: RunContext, phase: RunPlanPhase, priorResults?: PhaseResult[]): Promise<PhaseResult>;
}

export interface ScenarioRunnerDeps {
  environment?: PhaseRunner;
  onboarding?: PhaseRunner;
  stateValidation?: PhaseRunner;
  lifecycle?: PhaseRunner;
  runtime?: PhaseRunner;
}

export class ScenarioRunner {
  private readonly environment: PhaseRunner;
  private readonly onboarding: PhaseRunner;
  private readonly stateValidation: PhaseRunner;
  private readonly lifecycle: PhaseRunner;
  private readonly runtime: PhaseRunner;

  constructor(deps: ScenarioRunnerDeps = {}) {
    this.environment = deps.environment ?? new EnvironmentOrchestrator();
    this.onboarding = deps.onboarding ?? new OnboardingOrchestrator();
    this.stateValidation = deps.stateValidation ?? new StateValidationOrchestrator();
    this.lifecycle = deps.lifecycle ?? new LifecycleOrchestrator();
    this.runtime = deps.runtime ?? new RuntimeOrchestrator();
  }

  async run(ctx: RunContext, plan: RunPlan): Promise<PhaseResult[]> {
    // Seed context.env from the typed RunPlan once, before any phase
    // runs. Spec ownership: framework infrastructure (the runner), not
    // a shell action. Onboarding may extend context.env via
    // e2e_context_set; the runtime phase reads whatever is on disk.
    seedContextEnv(ctx, plan);

    const results: PhaseResult[] = [];
    for (const phase of plan.phases) {
      const blocked = phaseBlockedBy(phase.name, results);
      if (blocked) {
        // Cross-phase short-circuit: the previous phase's setup work
        // failed, so this phase cannot meaningfully run. Synthesize a
        // skipped PhaseResult with a clear reason so artifacts stay
        // honest (no false greens, no <1s assertion explosion).
        results.push({
          phase: phase.name,
          status: "skipped",
          actions: [],
          assertions: [
            {
              id: `${phase.name}.blocked`,
              status: "skipped",
              attempts: 0,
              durationMs: 0,
              message: `phase blocked by prior failure: ${blocked.phase} action ${blocked.action.id} failed (${blocked.action.message ?? "no message"})`,
            },
          ],
        });
        continue;
      }
      const orchestrator = this.orchestratorFor(phase.name);
      results.push(await orchestrator.run(ctx, phase, results));
    }

    // Negative-scenario contract verification. Single decision point:
    // if the plan declared expectedFailure, evaluate the matcher and
    // append a synthetic phase result. Positive scenarios are
    // unaffected. Side-effect verification stays the responsibility of
    // the state-validation phase; the matcher only judges phase + errorClass.
    if (plan.expectedFailure) {
      const contractResult = evaluateNegativeContract(plan, results);
      const synthetic = negativeContractPhaseResult(contractResult);
      results.push(synthetic);
      writeNegativeContractArtifact(ctx, contractResult, synthetic);
    }

    return results;
  }

  private orchestratorFor(name: RunPlanPhase["name"]): PhaseRunner {
    if (name === "environment") return this.environment;
    if (name === "onboarding") return this.onboarding;
    if (name === "state-validation") return this.stateValidation;
    if (name === "lifecycle") return this.lifecycle;
    if (name === "runtime") return this.runtime;
    throw new Error(`Unsupported phase: ${String(name)}`);
  }
}

interface BlockingFailure {
  phase: "environment" | "onboarding" | "state-validation" | "lifecycle" | "runtime";
  action: PhaseActionResult;
}

function writeNegativeContractArtifact(
  ctx: RunContext,
  contractResult: ReturnType<typeof evaluateNegativeContract>,
  synthetic: PhaseResult,
): void {
  try {
    const outputDir = path.join(ctx.contextDir, ".e2e");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "negative-contract.json"),
      `${JSON.stringify(contractResult, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outputDir, `${synthetic.phase}.result.json`),
      `${JSON.stringify(synthetic, null, 2)}\n`,
    );
  } catch {
    /* artifact emission is best-effort; matcher result already in memory */
  }
}

// state-validation is the typed diagnostic layer between onboarding
// and runtime. It probes gateway/sandbox/cli post-conditions and is
// the phase that proves a negative scenario's forbidden side effects
// did not occur (gateway-absent, sandbox-absent). For state-validation
// to do its job after a deliberate onboarding failure (negative
// scenarios), an onboarding failure must NOT block it. Only an
// environment-phase failure (install never ran) skips state-validation.
// Runtime stays blocked by any prior phase-action failure, including
// state-validation, so suites never run against a missing or wedged
// environment.
function phaseBlockedBy(
  phase: "environment" | "onboarding" | "state-validation" | "lifecycle" | "runtime",
  results: PhaseResult[],
): BlockingFailure | undefined {
  const firstFailure = firstBlockingActionFailure(results);
  if (!firstFailure) {
    return undefined;
  }
  if (phase === "state-validation" && firstFailure.phase !== "environment") {
    // state-validation is the diagnostic layer that proves a negative
    // scenario's forbidden side effects didn't occur, so an onboarding
    // failure must NOT block it.
    return undefined;
  }
  if (phase === "lifecycle" && firstFailure.phase === "state-validation") {
    // state-validation failure does not block the lifecycle phase
    // either: state-validation results are diagnostic. Lifecycle
    // workers depend on onboarding having produced a sandbox, but
    // not on state-validation probes having all passed.
    return undefined;
  }
  return firstFailure;
}

function firstBlockingActionFailure(results: PhaseResult[]): BlockingFailure | undefined {
  // A phase action failure (real setup work didn't succeed) blocks
  // downstream phases. Assertion failures do NOT block downstream
  // phases - they are expected to be reported alongside other phase
  // results so reviewers can see all failure layers at once.
  for (const result of results) {
    if (
      result.phase !== "environment" &&
      result.phase !== "onboarding" &&
      result.phase !== "state-validation" &&
      result.phase !== "lifecycle" &&
      result.phase !== "runtime"
    ) {
      continue;
    }
    const failedAction = result.actions.find((action) => action.status === "failed");
    if (failedAction) {
      return { phase: result.phase, action: failedAction };
    }
  }
  return undefined;
}
