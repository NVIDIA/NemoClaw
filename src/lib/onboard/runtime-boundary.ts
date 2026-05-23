// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import { OnboardRuntime } from "./machine/runtime";
import type { OnboardMachineEventType, OnboardMachineState } from "./machine/types";

export interface OnboardRuntimeBoundaryOptions {
  toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  maybeForceE2eStepFailure(stepName: string): void;
}

export class OnboardRuntimeBoundary {
  private runtime: OnboardRuntime | null = null;

  constructor(private readonly options: OnboardRuntimeBoundaryOptions) {}

  reset(): void {
    this.runtime = new OnboardRuntime();
  }

  clear(): void {
    this.runtime = null;
  }

  getRuntime(): OnboardRuntime {
    if (!this.runtime) this.runtime = new OnboardRuntime();
    return this.runtime;
  }

  recorders() {
    return {
      startRecordedStep: this.startRecordedStep.bind(this),
      recordStepComplete: this.recordStepComplete.bind(this),
      recordStepSkipped: this.recordStepSkipped.bind(this),
      recordStateSkipped: this.recordStateSkipped.bind(this),
      recordRepairEvent: this.recordRepairEvent.bind(this),
      recordStepFailed: this.recordStepFailed.bind(this),
      recordSessionComplete: this.recordSessionComplete.bind(this),
    };
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
    if (current.machine.state === "post_verify") {
      return runtime.complete(updates);
    }
    return runtime.completeSession(updates);
  }
}
