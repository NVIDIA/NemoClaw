// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SessionUpdates } from "../../state/onboard-session";
import type { OnboardMachineTransitionKind } from "./types";
import type { OnboardMachineState } from "./types";

export interface OnboardStateTransitionResult {
  type: "transition";
  next: OnboardMachineState;
  transitionKind?: OnboardMachineTransitionKind;
  updates?: SessionUpdates;
  metadata?: Record<string, unknown> | null;
}

export interface OnboardStateCompleteResult {
  type: "complete";
  updates?: SessionUpdates;
  metadata?: Record<string, unknown> | null;
}

export interface OnboardStateFailedResult {
  type: "failed";
  error: string | null;
  step?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type OnboardStateResult =
  | OnboardStateTransitionResult
  | OnboardStateCompleteResult
  | OnboardStateFailedResult;

export function transitionTo(
  next: OnboardMachineState,
  options: {
    transitionKind?: OnboardMachineTransitionKind;
    updates?: SessionUpdates;
    metadata?: Record<string, unknown> | null;
  } = {},
): OnboardStateTransitionResult {
  return {
    type: "transition",
    next,
    transitionKind: options.transitionKind,
    updates: options.updates,
    metadata: options.metadata,
  };
}

export function advanceTo(
  next: OnboardMachineState,
  options: Omit<Parameters<typeof transitionTo>[1], "transitionKind"> = {},
): OnboardStateTransitionResult {
  return transitionTo(next, { ...options, transitionKind: "advance" });
}

export function retryTo(
  next: OnboardMachineState,
  options: Omit<Parameters<typeof transitionTo>[1], "transitionKind"> = {},
): OnboardStateTransitionResult {
  return transitionTo(next, { ...options, transitionKind: "retry" });
}

export function branchTo(
  next: OnboardMachineState,
  options: Omit<Parameters<typeof transitionTo>[1], "transitionKind"> = {},
): OnboardStateTransitionResult {
  return transitionTo(next, { ...options, transitionKind: "branch" });
}

export function completeOnboardMachine(
  updates: SessionUpdates = {},
  metadata: Record<string, unknown> | null = null,
): OnboardStateCompleteResult {
  return { type: "complete", updates, metadata };
}

export function failOnboardMachine(
  error: string | null,
  options: { step?: string | null; metadata?: Record<string, unknown> | null } = {},
): OnboardStateFailedResult {
  return {
    type: "failed",
    error,
    step: options.step,
    metadata: options.metadata,
  };
}
