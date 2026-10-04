// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import type { OnboardStateFailedResult, OnboardStateResult } from "./machine/result";
import { OnboardRuntime } from "./machine/runtime";
import type { OnboardMachineEventType, OnboardMachineState } from "./machine/types";
import type { ResumeConfigConflict } from "./resume-config";

function assertResultHasNoContextUpdates(result: OnboardStateResult, action: string): void {
  if (result.type !== "transition" || !result.updates) {
    return;
  }
  if (!Object.values(result.updates).some((value) => value !== undefined)) {
    return;
  }
  throw new Error(`Cannot ${action} onboarding state result with context updates`);
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
      recordStepRejected: this.recordStepRejected.bind(this),
      recordStepSkipped: this.recordStepSkipped.bind(this),
      recordStateSkipped: this.recordStateSkipped.bind(this),
      recordRepairEvent: this.recordRepairEvent.bind(this),
      recordResumeConflict: this.recordResumeConflict.bind(this),
      recordStateResult: this.recordStateResult.bind(this),
      recordInvalidatedStateResult: this.recordInvalidatedStateResult.bind(this),
      recordStepCompleteWithStateResult: this.recordStepCompleteWithStateResult.bind(this),
      recordStepFailedWithStateResult: this.recordStepFailedWithStateResult.bind(this),
      recordStepFailed: this.recordStepFailed.bind(this),
      recordSessionComplete: this.recordSessionComplete.bind(this),
    };
  }

  async recordOnboardStarted(resumed: boolean): Promise<Session> {
    const runtime = this.getRuntime();
    const session = await runtime.start({ resumed });
    await runtime.emitPendingSessionRecovery();
    return session;
  }

  async startRecordedStep(
    stepName: string,
    updates: {
      sandboxName?: string | null;
      provider?: string | null;
      model?: string | null;
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

  async recordStepRejected(stepName: string): Promise<Session> {
    return this.getRuntime().markStepRejected(stepName);
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

  async recordStepCompleteWithStateResult(
    stepName: string,
    updates: SessionUpdates,
    result: OnboardStateResult,
  ): Promise<Session> {
    await this.getRuntime().assertResultWillApply(result);
    await this.getRuntime().markStepComplete(stepName, updates);
    return this.recordStateResult(result);
  }

  async recordStepFailedWithStateResult(
    stepName: string,
    message: string | null,
    result: OnboardStateFailedResult,
  ): Promise<Session> {
    await this.getRuntime().assertResultWillApply(result);
    await this.getRuntime().markStepFailed(stepName, message);
    return this.recordStateResult(result);
  }

  async recordInvalidatedStateResult(
    result: OnboardStateResult,
    options: {
      reason: "already_at_target" | "source_state_mismatch";
      currentState: OnboardMachineState;
      sourceState?: string | null;
    },
  ): Promise<Session> {
    if (result.type !== "transition") {
      throw new Error(`Cannot invalidate non-transition onboarding state result: ${result.type}`);
    }
    assertResultHasNoContextUpdates(result, "invalidate");
    return this.getRuntime().emitResultInvalidated({
      reason: options.reason,
      currentState: options.currentState,
      targetState: result.next,
      sourceState: options.sourceState,
      metadata: result.metadata,
    });
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

  async recordSessionComplete(updates: SessionUpdates = {}): Promise<Session> {
    const runtime = this.getRuntime();
    const current = await runtime.session();
    if (current.machine.state === "finalizing") {
      await runtime.transition("post_verify");
      return runtime.complete(updates);
    }
    return runtime.complete(updates);
  }
}
