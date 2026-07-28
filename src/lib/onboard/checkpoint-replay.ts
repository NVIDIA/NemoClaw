// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import type {
  CheckpointEffectGroupName,
  CheckpointSandboxIdentity,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import type { OnboardMachineState } from "./machine/types";
import { ONBOARD_MACHINE_STATES } from "./machine/types";

export interface CheckpointedMachineSession {
  readonly checkpoint: OnboardCheckpoint | null;
  readonly machine: { readonly state: OnboardMachineState };
}

export function checkpointSandboxIdentityMatches(
  session:
    | (CheckpointedMachineSession & {
        readonly sandboxName?: string | null;
        readonly sandboxPromptProgress?: { readonly sandboxName?: boolean };
      })
    | null
    | undefined,
  sandboxName: string,
): boolean {
  if (session?.checkpoint) {
    return (
      isDecisionSelected(session.checkpoint.sandboxIdentity) &&
      session.checkpoint.sandboxIdentity.value.name === sandboxName
    );
  }
  return (
    session?.sandboxPromptProgress?.sandboxName === true && session.sandboxName === sandboxName
  );
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
  | "fingerprint_mismatch"
  | "already_complete_revalidated";

export interface EffectGroupReplayDecision {
  readonly group: CheckpointEffectGroupName;
  readonly action: "skip" | "run";
  readonly reason: EffectGroupReplayReason;
}

export function planEffectGroupReplay(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  observedFingerprint: string | null,
): EffectGroupReplayDecision {
  const record = checkpoint.effectGroups[group];
  if (!record) return { group, action: "run", reason: "not_recorded" };
  if (!observedFingerprint) return { group, action: "run", reason: "postcondition_failed" };
  if (observedFingerprint !== record.fingerprint) {
    return { group, action: "run", reason: "fingerprint_mismatch" };
  }
  return { group, action: "skip", reason: "already_complete_revalidated" };
}

export function observeProviderEffectFingerprint(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  bindingMatches: (
    binding: OnboardCheckpoint["bindings"]["registeredProviders"][number],
  ) => boolean,
): string | null {
  const fingerprint = checkpoint.effectGroups[group]?.fingerprint;
  const providerNames = fingerprint?.split(",").filter(Boolean) ?? [];
  if (!fingerprint || providerNames.length === 0) return null;
  const bindingsByName = new Map(
    checkpoint.bindings.registeredProviders.map((binding) => [binding.name, binding]),
  );
  for (const name of providerNames) {
    const binding = bindingsByName.get(name);
    if (!binding || !bindingMatches(binding)) return null;
  }
  return providerNames.join(",");
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
