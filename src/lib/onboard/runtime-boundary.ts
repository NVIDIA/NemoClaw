// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import type { OnboardStateResult } from "./machine/result";
import { OnboardRuntime } from "./machine/runtime";
import type { ResumeConfigConflict } from "./resume-config";
import type { OnboardMachineEventType, OnboardMachineState } from "./machine/types";

function assertSkippableTransitionResult(result: OnboardStateResult): void {
  if (result.type !== "transition" || !result.updates || Object.keys(result.updates).length === 0) {
    return;
  }
  throw new Error("Cannot skip onboarding state result with context updates");
}

export interface OnboardRuntimeBoundaryOptions {
  toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  maybeForceE2eStepFailure(stepName: string): void;
  createRuntime?(): OnboardRuntime;
}

export class OnboardRuntimeBoundary {
  private runtime: OnboardRuntime | null = null;

  constructor(private readonly options: OnboardRuntimeBoundaryOptions) {}

  reset(): void {
    this.runtime = this.options.createRuntime?.() ?? new OnboardRuntime();
  }

  clear(): void {
    this.runtime = null;
  }

  getRuntime(): OnboardRuntime {
    if (!this.runtime) this.runtime = this.options.createRuntime?.() ?? new OnboardRuntime();
    return this.runtime;
  }

  recorders() {
    return {
      recordOnboardStarted: this.recordOnboardStarted.bind(this),
      startRecordedStep: this.startRecordedStep.bind(this),
      recordStepComplete: this.recordStepComplete.bind(this),
      recordStepSkipped: this.recordStepSkipped.bind(this),
      recordStateSkipped: this.recordStateSkipped.bind(this),
      recordRepairEvent: this.recordRepairEvent.bind(this),
      recordResumeConflict: this.recordResumeConflict.bind(this),
      recordStateResult: this.recordStateResult.bind(this),
      recordStateResultWithStepCompatibility: this.recordStateResultWithStepCompatibility.bind(this),
      recordStepFailed: this.recordStepFailed.bind(this),
      recordPostVerifyStarted: this.recordPostVerifyStarted.bind(this),
      recordSessionComplete: this.recordSessionComplete.bind(this),
    };
  }

  async recordOnboardStarted(resumed: boolean): Promise<Session> {
    return this.getRuntime().start({ resumed });
  }

  async startRecordedStep(
    stepName: string,
    updates: {
      sandboxName?: string | null;
      provider?: string | null;
      model?: string | null;
      policyPresets?: string[] | null;
    } = {},
  ): Promise<void> {
    const runtime = this.getRuntime();
    await runtime.markStepStarted(stepName);
    if (Object.keys(updates).length > 0) {
      await runtime.updateContext(this.options.toSessionUpdates(updates));
    }
    this.options.maybeForceE2eStepFailure(stepName);
  }

  async recordStepComplete(stepName: string, updates: SessionUpdates = {}): Promise<Session> {
    return this.getRuntime().markStepComplete(stepName, updates);
  }

  async recordStepSkipped(stepName: string): Promise<Session> {
    return this.getRuntime().markStepSkipped(stepName);
  }

  async recordStepFailed(stepName: string, message: string | null): Promise<Session> {
    return this.getRuntime().markStepFailed(stepName, message);
  }

  async recordStateSkipped(
    state: OnboardMachineState,
    metadata: Record<string, unknown> | null = null,
  ): Promise<Session> {
    return this.getRuntime().markSkipped(state, metadata);
  }

  async recordStateResult(result: OnboardStateResult): Promise<Session> {
    return this.getRuntime().applyResult(result);
  }

  async recordStateResultWithStepCompatibility(result: OnboardStateResult): Promise<Session> {
    const runtime = this.getRuntime();
    const current = await runtime.session();
    if (result.type !== "transition") return runtime.applyResult(result);

    if (current.machine.state === result.next) {
      assertSkippableTransitionResult(result);
      return runtime.emitResultSkipped({
        reason: "already_at_target",
        currentState: current.machine.state,
        targetState: result.next,
        metadata: result.metadata,
      });
    }

    const sourceState =
      result.metadata && typeof result.metadata.state === "string" ? result.metadata.state : null;
    if (sourceState && current.machine.state !== sourceState) {
      assertSkippableTransitionResult(result);
      return runtime.emitResultSkipped({
        reason: "source_state_mismatch",
        currentState: current.machine.state,
        targetState: result.next,
        metadata: { ...(result.metadata ?? {}), sourceState },
      });
    }

    return runtime.applyResult(result);
  }

  async recordStateResultsWithStepCompatibility(results: OnboardStateResult[]): Promise<Session> {
    let session = await this.getRuntime().session();
    for (const result of results) {
      session = await this.recordStateResultWithStepCompatibility(result);
    }
    return session;
  }

  async recordResumeConflict(conflict: ResumeConfigConflict): Promise<Session> {
    return this.getRuntime().emitResumeConflict(conflict);
  }

  async recordRepairEvent(
    type: Extract<
      OnboardMachineEventType,
      "state.repair.started" | "state.repair.completed" | "state.repair.failed"
    >,
    options: {
      state?: OnboardMachineState | null;
      error?: string | null;
      metadata?: Record<string, unknown> | null;
    } = {},
  ): Promise<Session> {
    return this.getRuntime().emitRepairEvent(type, options);
  }

  async recordPostVerifyStarted(): Promise<Session> {
    const runtime = this.getRuntime();
    const current = await runtime.session();
    if (current.machine.state === "finalizing") {
      return runtime.transition("post_verify");
    }
    return current;
  }

  async recordSessionComplete(updates: SessionUpdates = {}): Promise<Session> {
    const runtime = this.getRuntime();
    const current = await runtime.session();
    if (current.machine.state === "finalizing") {
      await runtime.transition("post_verify");
      return runtime.complete(updates);
    }
    if (current.machine.state === "post_verify") {
      return runtime.complete(updates);
    }
    return runtime.completeSession(updates);
  }
}
