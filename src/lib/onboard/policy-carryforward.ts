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
  if (!prev || prev.length === 0 || !nonInteractive)
    return { newPresets: null, overrideNote: null };
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

// True when a non-interactive run sets an env override that should replace the
// sandbox's recorded policy selection (NEMOCLAW_POLICY_PRESETS, or an explicit
// NEMOCLAW_POLICY_MODE). In interactive mode the recorded selection always wins.
function envOverridesRecordedPolicies(env: PolicyEnv, nonInteractive: boolean): boolean {
  if (!nonInteractive) return false;
  if ((env.NEMOCLAW_POLICY_PRESETS ?? "").trim().length > 0) return true;
  const mode = (env.NEMOCLAW_POLICY_MODE ?? "").trim().toLowerCase();
  return EXPLICIT_POLICY_MODES.includes(mode);
}

// Decide the policy presets to seed into a *reused* sandbox's fresh onboard
// session (`nemoclaw onboard --name <existing>` without --recreate-sandbox).
//
// Unlike decidePolicyCarryForward (the recreate path), this preserves an
// intentionally-empty recorded selection (e.g. the Restricted tier, or all tier
// presets deselected): an empty array is carried forward as `[]` so the policy
// step reapplies "no presets" instead of falling back to the default Balanced
// tier and re-adding presets the operator removed. `null`/absent recorded state
// still yields `null` (let the policy step prompt). A non-interactive env
// override (NEMOCLAW_POLICY_PRESETS / NEMOCLAW_POLICY_MODE) still wins and
// returns `null` so the override drives the selection. See #4621.
export function decideReusePolicyPresets(
  recordedAppliedPresets: string[] | null | undefined,
  env: PolicyEnv,
  nonInteractive: boolean,
): string[] | null {
  if (!Array.isArray(recordedAppliedPresets)) return null;
  if (envOverridesRecordedPolicies(env, nonInteractive)) return null;
  return recordedAppliedPresets;
}
