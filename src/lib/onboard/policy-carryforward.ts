// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Decides whether `nemoclaw onboard --recreate-sandbox` should carry the
// previous sandbox's policy presets forward into the new session, or honour
// a `NEMOCLAW_POLICY_PRESETS` / `NEMOCLAW_POLICY_MODE` environment override.
// See #2675.
//
// "suggested"/"default"/"auto" are intentionally absent from EXPLICIT_POLICY_MODES:
// they map to the implicit carry-forward semantic, equivalent to leaving
// NEMOCLAW_POLICY_MODE unset.
export const EXPLICIT_POLICY_MODES = ["skip", "none", "no", "custom", "list"];

export type PolicyEnv = {
  NEMOCLAW_POLICY_PRESETS?: string;
  NEMOCLAW_POLICY_MODE?: string;
};

export function shouldCarryPreviousPolicies(
  previousPolicies: string[] | null | undefined,
  env: PolicyEnv,
  nonInteractive: boolean,
): boolean {
  if (!Array.isArray(previousPolicies) || previousPolicies.length === 0) return false;
  if (!nonInteractive) return true;
  if ((env.NEMOCLAW_POLICY_PRESETS ?? "").trim().length > 0) return false;
  const mode = (env.NEMOCLAW_POLICY_MODE ?? "").trim().toLowerCase();
  if (EXPLICIT_POLICY_MODES.includes(mode)) return false;
  return true;
}

export type PolicyCarryForwardDecision = {
  // The value to assign to session.policyPresets: `previousPolicies` when the
  // recreate path carries them forward, otherwise `null` to clear the slot.
  newPresets: string[] | null;
  // Human-readable note explaining that an env override is replacing the
  // recorded presets. Null when no note is warranted.
  overrideNote: string | null;
};

export function decidePolicyCarryForward(
  previousPolicies: string[] | null | undefined,
  env: PolicyEnv,
  nonInteractive: boolean,
): PolicyCarryForwardDecision {
  const prev = Array.isArray(previousPolicies) ? previousPolicies : null;
  if (shouldCarryPreviousPolicies(prev, env, nonInteractive)) {
    return { newPresets: prev, overrideNote: null };
  }
  if (!prev || prev.length === 0 || !nonInteractive) return { newPresets: null, overrideNote: null };
  const wasList = prev.join(", ");
  if ((env.NEMOCLAW_POLICY_PRESETS ?? "").trim().length > 0) {
    return {
      newPresets: null,
      overrideNote: `  [non-interactive] NEMOCLAW_POLICY_PRESETS overrides previous presets on recreate (was: ${wasList}).`,
    };
  }
  const mode = (env.NEMOCLAW_POLICY_MODE ?? "").trim().toLowerCase();
  if (EXPLICIT_POLICY_MODES.includes(mode)) {
    return {
      newPresets: null,
      overrideNote: `  [non-interactive] NEMOCLAW_POLICY_MODE=${mode} overrides previous presets on recreate (was: ${wasList}).`,
    };
  }
  return { newPresets: null, overrideNote: null };
}
