// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import {
  RECORD_ONLY_STEP_MUTATION_OPTIONS,
  type StepMutationOptions,
  shouldUpdateMachine,
} from "../state/onboard-step-mutation";
import type { OnboardStateFailedResult, OnboardStateResult } from "./machine/result";
import { advanceTo } from "./machine/result";
import { OnboardRuntime } from "./machine/runtime";
import { assertValidOnboardMachineTransition } from "./machine/transitions";
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
  /**
   * Override for legacy/test harnesses. Production boundary writes default to
   * status-only step mutations so explicit OnboardStateResult transitions stay
   * the durable machine source of truth.
   */
  stepMutationOptions?: StepMutationOptions;
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
      recordInvalidatedStateResult: this.recordInvalidatedStateResult.bind(this),
      recordStepCompleteWithStateResult: this.recordStepCompleteWithStateResult.bind(this),
      recordStepFailedWithStateResult: this.recordStepFailedWithStateResult.bind(this),
      recordStepFailed: this.recordStepFailed.bind(this),
      recordPostVerifyStarted: this.recordPostVerifyStarted.bind(this),
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
      policyPresets?: string[] | null;
    } = {},
  ): Promise<void> {
    const runtime = this.getRuntime();
    await runtime.markStepStarted(stepName, this.stepMutationOptions());
    if (Object.keys(updates).length > 0) {
      await runtime.updateContext(this.options.toSessionUpdates(updates));
    }
    this.options.maybeForceE2eStepFailure(stepName);
  }

  async recordStepComplete(stepName: string, updates: SessionUpdates = {}): Promise<Session> {
    return this.getRuntime().markStepComplete(stepName, updates, this.stepMutationOptions());
  }

  async recordStepSkipped(stepName: string): Promise<Session> {
    return this.getRuntime().markStepSkipped(stepName);
  }

  async recordStepFailed(stepName: string, message: string | null): Promise<Session> {
    return this.getRuntime().markStepFailed(stepName, message, this.stepMutationOptions());
  }

  private stepMutationOptions(): StepMutationOptions {
    return this.options.stepMutationOptions ?? RECORD_ONLY_STEP_MUTATION_OPTIONS;
  }

  private usesLegacyMachineStepMutation(): boolean {
    return shouldUpdateMachine(this.stepMutationOptions());
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

  private async assertStateResultWillApply(result: OnboardStateResult): Promise<void> {
    const current = await this.getRuntime().session();
    if (result.type === "failed") {
      assertValidOnboardMachineTransition(current.machine.state, "failed");
      return;
    }
    if (result.type === "complete") {
      assertValidOnboardMachineTransition(current.machine.state, "complete");
      return;
    }

    if (result.type === "pause") {
      const sourceState =
        result.metadata && typeof result.metadata.state === "string" ? result.metadata.state : null;
      if (sourceState && current.machine.state !== sourceState) {
        throw new Error(
          `Paused onboarding state result source mismatch: ${sourceState} != ${current.machine.state}`,
        );
      }
      return;
    }

    const sourceState =
      result.metadata && typeof result.metadata.state === "string" ? result.metadata.state : null;
    if (current.machine.state === result.next) {
      throw new Error(`Record-only step result already reached target state: ${result.next}`);
    }
    if (sourceState && current.machine.state !== sourceState) {
      throw new Error(
        `Record-only step result source mismatch: ${sourceState} != ${current.machine.state}`,
      );
    }
    const transition = assertValidOnboardMachineTransition(current.machine.state, result.next);
    if (result.transitionKind && transition.kind !== result.transitionKind) {
      throw new Error(
        `Invalid onboarding machine transition kind: ${current.machine.state} -> ${result.next} expected ${result.transitionKind}, got ${transition.kind}`,
      );
    }
  }

  async recordStepCompleteWithStateResult(
    stepName: string,
    updates: SessionUpdates,
    result: OnboardStateResult,
  ): Promise<Session> {
    await this.assertStateResultWillApply(result);
    await this.getRuntime().markStepCompleteRecordOnly(stepName, updates);
    return this.recordStateResult(result);
  }

  async recordStepFailedWithStateResult(
    stepName: string,
    message: string | null,
    result: OnboardStateFailedResult,
  ): Promise<Session> {
    await this.assertStateResultWillApply(result);
    await this.getRuntime().markStepFailedRecordOnly(stepName, message);
    return this.recordStateResult(result);
  }

  /**
   * Compatibility bridge for legacy/test boundaries explicitly configured with
   * `updateMachine === true`.
   *
   * Default record-only paths reject stale transition results before applying
   * them. Skipped legacy results must stay metadata-only so stale results cannot
   * become a context source. Live resume replay uses
   * `recordInvalidatedStateResult` instead so recomputed-but-stale results are
   * explicitly invalidated rather than accepted through this compatibility path.
   */
  async recordStateResultWithStepCompatibility(result: OnboardStateResult): Promise<Session> {
    const runtime = this.getRuntime();
    const current = await runtime.session();
    if (result.type !== "transition") return runtime.applyResult(result);

    if (!this.usesLegacyMachineStepMutation()) {
      await this.assertStateResultWillApply(result);
      return runtime.applyResult(result);
    }

    if (current.machine.state === result.next) {
      assertResultHasNoContextUpdates(result, "skip");
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
      assertResultHasNoContextUpdates(result, "skip");
      return runtime.emitResultSkipped({
        reason: "source_state_mismatch",
        currentState: current.machine.state,
        targetState: result.next,
        metadata: { ...(result.metadata ?? {}), sourceState },
      });
    }

    return runtime.applyResult(result);
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

  /**
   * Record the initial `init -> preflight` transition, honoring resume semantics.
   * Fresh onboarding applies the transition; resumes invalidate stale replay
   * results when the session has already advanced past `init`.
   */
  async recordInitialPreflightTransition(resume: boolean): Promise<void> {
    const result = advanceTo("preflight", { metadata: { state: "init" } });
    if (!resume) {
      await this.recordStateResultWithStepCompatibility(result);
      return;
    }
    const current = await this.getRuntime().session();
    if (current.machine.state === result.next) {
      await this.recordInvalidatedStateResult(result, {
        reason: "already_at_target",
        currentState: current.machine.state,
        sourceState: "init",
      });
      return;
    }
    if (current.machine.state !== "init") {
      await this.recordInvalidatedStateResult(result, {
        reason: "source_state_mismatch",
        currentState: current.machine.state,
        sourceState: "init",
      });
      return;
    }
    await this.recordStateResultWithStepCompatibility(result);
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
