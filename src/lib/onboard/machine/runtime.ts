// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "../../core/json-types";
import * as onboardSession from "../../state/onboard-session";
import type { Session, SessionUpdates } from "../../state/onboard-session";
import {
  createOnboardMachineEvent,
  emitOnboardMachineEvent,
  type OnboardMachineEvent,
} from "./events";
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
  markStepStarted(stepName: string): Session;
  markStepComplete(stepName: string, updates?: SessionUpdates): Session;
  markStepSkipped(stepName: string): Session;
  markStepFailed(stepName: string, message?: string | null): Session;
  completeSession(updates?: SessionUpdates): Session;
  filterSafeUpdates(updates: SessionUpdates): Partial<Session>;
  emitEvent(event: OnboardMachineEvent): void;
  now(): string;
}

export type OnboardRuntimeTransitionOptions = {
  metadata?: Record<string, unknown> | null;
};

export type OnboardRuntimeUpdateOptions = {
  state?: OnboardMachineState | null;
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
    markStepSkipped: onboardSession.markStepSkipped,
    markStepFailed: onboardSession.markStepFailed,
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

  async start(options: { resumed?: boolean; metadata?: Record<string, unknown> | null } = {}): Promise<Session> {
    const session = this.ensureSession();
    this.emit(options.resumed === true ? "onboard.resumed" : "onboard.started", session, {
      state: session.machine.state,
      metadata: options.metadata,
    });
    return session;
  }

  async markStepStarted(stepName: string): Promise<Session> {
    return this.deps.markStepStarted(stepName);
  }

  async markStepComplete(stepName: string, updates: SessionUpdates = {}): Promise<Session> {
    return this.deps.markStepComplete(stepName, updates);
  }

  async markStepSkipped(stepName: string): Promise<Session> {
    return this.deps.markStepSkipped(stepName);
  }

  async markStepFailed(stepName: string, message: string | null = null): Promise<Session> {
    return this.deps.markStepFailed(stepName, message);
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

  async complete(updates: SessionUpdates = {}): Promise<Session> {
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
        metadata: { fields },
      });
    }
    this.emit("state.completed", updated, { state: from });
    this.emit("state.entered", updated, { state: "complete" });
    this.emit("onboard.completed", updated, { state: "complete" });
    return updated;
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
