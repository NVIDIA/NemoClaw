// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ONBOARD_MACHINE_STATES } from "./machine/types";
import type { OnboardMachineState } from "./machine/types";
import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import type {
  CheckpointEffectGroupName,
  CheckpointSandboxIdentity,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";

export interface CheckpointedMachineSession {
  readonly checkpoint: OnboardCheckpoint | null;
  readonly machine: { readonly state: OnboardMachineState };
}

export function checkpointProvesSandboxStepComplete(
  session: CheckpointedMachineSession | null | undefined,
): boolean {
  if (!session?.checkpoint) return false;
  const sandboxIndex = ONBOARD_MACHINE_STATES.indexOf("sandbox");
  const stateIndex = ONBOARD_MACHINE_STATES.indexOf(session.machine.state);
  return stateIndex > sandboxIndex;
}

export type EffectGroupReplayReason =
  | "not_recorded"
  | "postcondition_failed"
  | "already_complete_revalidated";

export interface EffectGroupReplayDecision {
  readonly group: CheckpointEffectGroupName;
  readonly action: "skip" | "run";
  readonly reason: EffectGroupReplayReason;
}

export function planEffectGroupReplay(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  postconditionHolds: boolean,
): EffectGroupReplayDecision {
  const record = checkpoint.effectGroups[group];
  if (!record) return { group, action: "run", reason: "not_recorded" };
  if (!postconditionHolds) return { group, action: "run", reason: "postcondition_failed" };
  return { group, action: "skip", reason: "already_complete_revalidated" };
}

export interface SandboxCreateObservation {
  readonly liveSandboxExists: boolean;
}

export type SandboxCreateReplayDecision =
  | { readonly action: "reuse"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "create"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "capture_identity_first" };

export function planSandboxCreateReplay(
  checkpoint: OnboardCheckpoint,
  observed: SandboxCreateObservation,
): SandboxCreateReplayDecision {
  if (!isDecisionSelected(checkpoint.sandboxIdentity)) {
    return { action: "capture_identity_first" };
  }
  const identity = checkpoint.sandboxIdentity.value;
  if (observed.liveSandboxExists) {
    return { action: "reuse", identity };
  }
  return { action: "create", identity };
}
