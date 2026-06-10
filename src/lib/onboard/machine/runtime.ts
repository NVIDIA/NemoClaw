// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "../../core/json-types";
import type { Session, SessionUpdates } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import type { StepMutationOptions } from "../../state/onboard-step-mutation";
import type { ResumeConfigConflict } from "../resume-config";
import {
  createOnboardMachineEvent,
  emitOnboardMachineEvent,
  type OnboardMachineEvent,
} from "./events";
import type { OnboardStateResult } from "./result";
import {
  assertValidOnboardMachineTransition,
  canTransitionOnboardMachineState,
  isTerminalOnboardMachineState,
} from "./transitions";
import type { OnboardMachineEventType, OnboardMachineState } from "./types";

export interface OnboardRuntimeDeps {
  loadSession(): Session | null;
  createSession(overrides?: Partial<Session>): Session;
  saveSession(session: Session): Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
  markStepStarted(stepName: string, options?: StepMutationOptions): Session;
  markStepComplete(
    stepName: string,
    updates?: SessionUpdates,
    options?: StepMutationOptions,
  ): Session;
  markStepCompleteRecordOnly(stepName: string, updates?: SessionUpdates): Session;
  markStepSkipped(stepName: string): Session;
  markStepFailed(stepName: string, message?: string | null, options?: StepMutationOptions): Session;
  markStepFailedRecordOnly(stepName: string, message?: string | null): Session;
  completeSession(updates?: SessionUpdates): Session;
  filterSafeUpdates(updates: SessionUpdates): Partial<Session>;
  emitEvent(event: OnboardMachineEvent): void;
  now(): string;
}

export type OnboardRuntimeTransitionOptions = {
  metadata?: Record<string, unknown> | null;
};

function safeResumeConflictValue(
  conflict: ResumeConfigConflict,
  value: string | null,
): string | null {
  if (conflict.field === "fromDockerfile" && value) return "<path>";
  return value;
}

export type OnboardRuntimeUpdateOptions = {
  state?: OnboardMachineState | null;
  metadata?: Record<string, unknown> | null;
};

export type OnboardRuntimeCompleteOptions = {
  metadata?: Record<string, unknown> | null;
};

export type OnboardRuntimeFailureOptions = {
  step?: string | null;
  metadata?: Record<string, unknown> | null;
};

function defaultDeps(): OnboardRuntimeDeps {
  return {
    loadSession: onboardSession.loadSession,
    createSession: onboardSession.createSession,
    saveSession: onboardSession.saveSession,
    updateSession: onboardSession.updateSession,
    markStepStarted: onboardSession.markStepStarted,
    markStepComplete: onboardSession.markStepComplete,
    markStepCompleteRecordOnly: onboardSession.markStepCompleteRecordOnly,
    markStepSkipped: onboardSession.markStepSkipped,
    markStepFailed: onboardSession.markStepFailed,
    markStepFailedRecordOnly: onboardSession.markStepFailedRecordOnly,
    completeSession: onboardSession.completeSession,
    filterSafeUpdates: onboardSession.filterSafeUpdates,
    emitEvent: emitOnboardMachineEvent,
    now: () => new Date().toISOString(),
  };
}

function eventMetadata(metadata: Record<string, unknown> | null | undefined): JsonObject {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as JsonObject)
    : {};
}

function snapshotFor(
  state: OnboardMachineState,
  stateEnteredAt: string | null,
  revision: number,
): onboardSession.OnboardMachineSnapshot {
  return {
    version: onboardSession.MACHINE_SNAPSHOT_VERSION,
    state,
    stateEnteredAt,
    revision: Math.max(0, Math.trunc(revision)),
  };
}

export class OnboardRuntime {
  private readonly deps: OnboardRuntimeDeps;

  constructor(deps: Partial<OnboardRuntimeDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  async session(): Promise<Session> {
    return this.ensureSession();
  }

  async start(
    options: { resumed?: boolean; metadata?: Record<string, unknown> | null } = {},
  ): Promise<Session> {
    const session = this.ensureSession();
    this.emit(options.resumed === true ? "onboard.resumed" : "onboard.started", session, {
      state: session.machine.state,
      metadata: options.metadata,
    });
    return session;
  }

  async markStepStarted(stepName: string, options: StepMutationOptions = {}): Promise<Session> {
    return this.deps.markStepStarted(stepName, options);
  }

  async markStepComplete(
    stepName: string,
    updates: SessionUpdates = {},
    options: StepMutationOptions = {},
  ): Promise<Session> {
    return this.deps.markStepComplete(stepName, updates, options);
  }

  async markStepCompleteRecordOnly(
    stepName: string,
    updates: SessionUpdates = {},
  ): Promise<Session> {
    return this.deps.markStepCompleteRecordOnly(stepName, updates);
  }

  async markStepSkipped(stepName: string): Promise<Session> {
    return this.deps.markStepSkipped(stepName);
  }

  async markStepFailed(
    stepName: string,
    message: string | null = null,
    options: StepMutationOptions = {},
  ): Promise<Session> {
    return this.deps.markStepFailed(stepName, message, options);
  }

  async markStepFailedRecordOnly(
    stepName: string,
    message: string | null = null,
  ): Promise<Session> {
    return this.deps.markStepFailedRecordOnly(stepName, message);
  }

  async completeSession(updates: SessionUpdates = {}): Promise<Session> {
    return this.deps.completeSession(updates);
  }

  async transition(
    to: OnboardMachineState,
    options: OnboardRuntimeTransitionOptions = {},
  ): Promise<Session> {
    const current = this.ensureSession();
    const from = current.machine.state;
    assertValidOnboardMachineTransition(from, to);

    const enteredAt = this.deps.now();
    const updated = this.deps.updateSession((session) => {
      session.machine = snapshotFor(to, enteredAt, session.machine.revision + 1);
      if (to === "failed") {
        session.status = "failed";
      } else if (to === "complete") {
        session.status = "complete";
        session.resumable = false;
        session.failure = null;
      } else if (session.status !== "failed") {
        session.status = "in_progress";
      }
      return session;
    });

    this.emit("state.exited", updated, { state: from, metadata: options.metadata });
    this.emit("state.entered", updated, { state: to, metadata: options.metadata });
    return updated;
  }

  async updateContext(
    updates: SessionUpdates,
    options: OnboardRuntimeUpdateOptions = {},
  ): Promise<Session> {
    const safeUpdates = this.deps.filterSafeUpdates(updates);
    const fields = Object.keys(safeUpdates);
    const updated = this.deps.updateSession((session) => {
      Object.assign(session, safeUpdates);
      return session;
    });
    if (fields.length > 0) {
      this.emit("context.updated", updated, {
        state: options.state ?? updated.machine.state,
        metadata: { ...eventMetadata(options.metadata), fields },
      });
    }
    return updated;
  }

  async complete(
    updates: SessionUpdates = {},
    options: OnboardRuntimeCompleteOptions = {},
  ): Promise<Session> {
    const current = this.ensureSession();
    const from = current.machine.state;
    assertValidOnboardMachineTransition(from, "complete");

    const safeUpdates = this.deps.filterSafeUpdates(updates);
    const fields = Object.keys(safeUpdates);
    const enteredAt = this.deps.now();
    const updated = this.deps.updateSession((session) => {
      Object.assign(session, safeUpdates);
      session.status = "complete";
      session.resumable = false;
      session.failure = null;
      session.machine = snapshotFor("complete", enteredAt, session.machine.revision + 1);
      return session;
    });

    if (fields.length > 0) {
      this.emit("context.updated", updated, {
        state: "complete",
        metadata: { ...eventMetadata(options.metadata), fields },
      });
    }
    this.emit("state.completed", updated, { state: from, metadata: options.metadata });
    this.emit("state.entered", updated, { state: "complete", metadata: options.metadata });
    this.emit("onboard.completed", updated, {
      state: "complete",
      metadata: options.metadata,
    });
    return updated;
  }

  async applyResult(result: OnboardStateResult): Promise<Session> {
    if (result.type === "complete") {
      return this.complete(result.updates ?? {}, { metadata: result.metadata });
    }
    if (result.type === "failed") {
      return this.fail(result.error, {
        step: result.step,
        metadata: result.metadata,
      });
    }

    const current = this.ensureSession();
    const transition = assertValidOnboardMachineTransition(current.machine.state, result.next);
    if (result.transitionKind && transition.kind !== result.transitionKind) {
      throw new Error(
        `Invalid onboarding machine transition kind: ${current.machine.state} -> ${result.next} expected ${result.transitionKind}, got ${transition.kind}`,
      );
    }
    if (result.updates && Object.keys(this.deps.filterSafeUpdates(result.updates)).length > 0) {
      await this.updateContext(result.updates, {
        state: current.machine.state,
        metadata: result.metadata,
      });
    }
    return this.transition(result.next, { metadata: result.metadata });
  }

  async fail(message: string | null, options: OnboardRuntimeFailureOptions = {}): Promise<Session> {
    const current = this.ensureSession();
    const from = current.machine.state;
    if (!canTransitionOnboardMachineState(from, "failed")) {
      assertValidOnboardMachineTransition(from, "failed");
    }

    const recordedAt = this.deps.now();
    const updated = this.deps.updateSession((session) => {
      session.status = "failed";
      session.failure = onboardSession.sanitizeFailure({
        step: options.step ?? null,
        message,
        recordedAt,
      });
      session.machine = snapshotFor("failed", recordedAt, session.machine.revision + 1);
      return session;
    });

    this.emit("state.failed", updated, {
      state: from,
      step: options.step,
      error: message,
      metadata: options.metadata,
    });
    this.emit("onboard.failed", updated, {
      state: "failed",
      step: options.step,
      error: message,
      metadata: options.metadata,
    });
    return updated;
  }

  async markSkipped(
    state: OnboardMachineState,
    metadata: Record<string, unknown> | null = null,
  ): Promise<Session> {
    const session = this.ensureSession();
    if (isTerminalOnboardMachineState(state)) {
      throw new Error(`Terminal onboarding state cannot be skipped: ${state}`);
    }
    this.emit("state.skipped", session, { state, metadata });
    return session;
  }

  async emitResultSkipped(options: {
    reason: "already_at_target" | "source_state_mismatch";
    currentState: OnboardMachineState;
    targetState: OnboardMachineState;
    metadata?: Record<string, unknown> | null;
  }): Promise<Session> {
    const session = this.ensureSession();
    this.emit("state.result.skipped", session, {
      state: session.machine.state,
      metadata: {
        ...eventMetadata(options.metadata),
        reason: options.reason,
        currentState: options.currentState,
        targetState: options.targetState,
      },
    });
    return session;
  }

  async emitResumeConflict(conflict: ResumeConfigConflict): Promise<Session> {
    const session = this.ensureSession();
    this.emit("resume.conflict", session, {
      state: session.machine.state,
      metadata: {
        field: conflict.field,
        recorded: safeResumeConflictValue(conflict, conflict.recorded),
        requested: safeResumeConflictValue(conflict, conflict.requested),
      },
    });
    return session;
  }

  async emitRepairEvent(
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
    const session = this.ensureSession();
    this.emit(type, session, {
      state: options.state ?? session.machine.state,
      error: options.error ?? null,
      metadata: options.metadata,
    });
    return session;
  }

  private ensureSession(): Session {
    const existing = this.deps.loadSession();
    if (existing) return existing;
    return this.deps.saveSession(this.deps.createSession());
  }

  private emit(
    type: OnboardMachineEventType,
    session: Session,
    options: {
      state?: OnboardMachineState | null;
      step?: string | null;
      error?: string | null;
      metadata?: Record<string, unknown> | null;
    } = {},
  ): void {
    this.deps.emitEvent(
      createOnboardMachineEvent({
        type,
        session,
        state: options.state ?? session.machine.state,
        step: options.step ?? null,
        error: options.error ?? null,
        metadata: options.metadata,
      }),
    );
  }
}
