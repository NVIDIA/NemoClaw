// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../state/onboard-session";
import { OnboardRuntime } from "./machine/runtime";

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

  async recordSessionComplete(updates: SessionUpdates = {}): Promise<Session> {
    return this.getRuntime().completeSession(updates);
  }
}
