// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  AssertionResult,
  AssertionStep,
  PhaseName,
  PhaseResult,
  RunContext,
  RunPlanPhase,
  TransientClassifier,
} from "../types.ts";

interface StepAttemptOutcome {
  status: "passed" | "failed";
  classifier?: TransientClassifier;
  message?: string;
}

function transientForRef(ref: string): TransientClassifier {
  if (ref.includes("provider") || ref.includes("transient")) {
    return "provider-transient";
  }
  if (ref.includes("gateway")) {
    return "gateway-transient";
  }
  return "runner-infra";
}

export class PhaseOrchestrator {
  constructor(private readonly phaseName: PhaseName) {}

  async run(ctx: RunContext, phase: RunPlanPhase): Promise<PhaseResult> {
    const assertions: AssertionResult[] = [];
    for (const group of phase.assertionGroups) {
      for (const step of group.steps) {
        assertions.push(await this.runStep(ctx, step));
      }
    }
    const status = assertions.some((assertion) => assertion.status === "failed") ? "failed" : "passed";
    const result: PhaseResult = { phase: this.phaseName, status, assertions };
    this.writePhaseResult(ctx, result);
    return result;
  }

  private async runStep(ctx: RunContext, step: AssertionStep): Promise<AssertionResult> {
    const startedAt = Date.now();
    const rawAttempts = step.reliability?.retry?.attempts;
    const maxAttempts = typeof rawAttempts === "number" && Number.isFinite(rawAttempts) ? Math.max(1, Math.floor(rawAttempts)) : 1;
    let attempts = 0;
    let lastOutcome: StepAttemptOutcome = { status: "failed", message: "step did not run" };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      lastOutcome = await this.executeStep(ctx, step, attempt);
      if (lastOutcome.status === "passed") {
        return {
          id: step.id,
          status: "passed",
          attempts,
          durationMs: Date.now() - startedAt,
          classifier: attempt > 1 ? step.reliability?.retry?.on[0] : lastOutcome.classifier,
          evidence: step.evidencePath,
          message: lastOutcome.message,
        };
      }
      if (!this.canRetry(step, lastOutcome.classifier, attempt, maxAttempts)) {
        break;
      }
    }
    return {
      id: step.id,
      status: "failed",
      attempts,
      durationMs: Date.now() - startedAt,
      classifier: lastOutcome.classifier,
      evidence: step.evidencePath,
      message: lastOutcome.message,
    };
  }

  private canRetry(
    step: AssertionStep,
    classifier: TransientClassifier | undefined,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (attempt >= maxAttempts || !classifier) {
      return false;
    }
    return step.reliability?.retry?.on.includes(classifier) ?? false;
  }

  private async executeStep(_ctx: RunContext, step: AssertionStep, attempt: number): Promise<StepAttemptOutcome> {
    const ref = step.implementation?.ref ?? "";
    if (ref === "fake-pass" || ref === "phase-1-skeleton") {
      return { status: "passed" };
    }
    if (ref === "fake-retry-once-pass") {
      return attempt === 1
        ? { status: "failed", classifier: step.reliability?.retry?.on[0] ?? "gateway-transient" }
        : { status: "passed" };
    }
    if (ref === "fake-always-transient") {
      return { status: "failed", classifier: step.reliability?.retry?.on[0] ?? transientForRef(ref) };
    }
    if (step.implementation?.kind === "shell" && _ctx.dryRun) {
      return { status: "passed", message: `dry-run shell ${ref}` };
    }
    if (step.implementation?.kind === "probe" && _ctx.dryRun) {
      return { status: "passed", message: `dry-run probe ${ref}` };
    }
    return { status: "failed", message: `unsupported live step ${step.id}` };
  }

  private writePhaseResult(ctx: RunContext, result: PhaseResult) {
    const outputDir = path.join(ctx.contextDir, ".e2e");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `${result.phase}.result.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}
