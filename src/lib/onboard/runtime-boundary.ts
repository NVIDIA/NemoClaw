// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import type { StepMutationOptions } from "../state/onboard-step-mutation";
import type { OnboardStateFailedResult, OnboardStateResult } from "./machine/result";
import { OnboardRuntime } from "./machine/runtime";
import { assertValidOnboardMachineTransition } from "./machine/transitions";
import type { OnboardMachineEventType, OnboardMachineState } from "./machine/types";
import type { ResumeConfigConflict } from "./resume-config";

function assertSkippableTransitionResult(result: OnboardStateResult): void {
  if (result.type !== "transition" || !result.updates) {
    return;
  }
  if (!Object.values(result.updates).some((value) => value !== undefined)) {
    return;
  }
  throw new Error("Cannot skip onboarding state result with context updates");
}

const RECORD_ONLY_STEP_MUTATION_OPTIONS: StepMutationOptions = { updateMachine: false };

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
      recordStepCompleteWithStateResult: this.recordStepCompleteWithStateResult.bind(this),
      recordStepFailedWithStateResult: this.recordStepFailedWithStateResult.bind(this),
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
    return this.recordStateResultWithStepCompatibility(result);
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
   * Compatibility bridge for the live onboarding host glue while legacy step helpers remain a
   * second machine snapshot writer. `markStepStarted()` and `markStepComplete()` still mutate
   * `session.machine` in src/lib/state/onboard-session.ts, so handlers that also return FSM
   * transition results can hand back a result whose target has already been reached or whose
   * source state is stale after a later legacy step advanced the snapshot. This change is limited
   * to consuming handler results at the runtime boundary; removing legacy step mutation is a
   * broader persistence/resume migration. Skipped transition results must stay metadata-only:
   * applying context updates after skipping a transition would
   * make the stale result an implicit source of truth. Remove this bridge once legacy step helpers
   * no longer advance `session.machine` and handler FSM results are the only transition source.
   */
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
