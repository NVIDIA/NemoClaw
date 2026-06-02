// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keeps the sandbox registry's recorded policy selection in sync with the
// operator's *effective* choice across onboard, reuse, and recreate, and seeds
// a fresh re-onboard session from that recorded selection so the policy step
// preserves preset removals instead of silently reapplying tier defaults.
// See #4621.

import type { Session } from "../state/onboard-session";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import {
  decidePolicyCarryForward,
  decideReusePolicyPresets,
  type PolicyEnv,
} from "./policy-carryforward";

// `../policy` pulls in the heavy runner stack at load time, so require it lazily
// inside the default accessors below. The policy-backed reads are injectable so
// the module (and its pure decision helpers) stays import-safe for unit tests.
function loadPolicyModule(): typeof import("../policy") {
  return require("../policy");
}

function defaultGetAppliedPresets(sandboxName: string): string[] {
  return loadPolicyModule().getAppliedPresets(sandboxName);
}

function defaultListBuiltinPresetNames(): string[] {
  return loadPolicyModule()
    .listPresets()
    .map((preset) => preset.name);
}

/**
 * Build the registry update for a *completed* policy step.
 *
 * `policies` is the built-in preset list only; sandbox-scoped custom presets
 * are tracked separately in `customPolicies`. Filter the effective selection to
 * built-in names, excluding any recorded custom-preset name (a custom preset
 * may share a built-in's name, e.g. a custom `brave`), so a custom preset is
 * not misclassified as a built-in — which would duplicate it in
 * getAppliedPresets and mislead policy-remove / rebuild / status.
 * `policyPresetsFinalized` records that the step fully reconciled the live set,
 * so a later re-onboard can distinguish this from boot-time-only `policies`
 * left behind by an interrupted run.
 */
export function buildFinalizedPolicyPresetsUpdate(
  appliedPolicyPresets: string[],
  builtinPresetNames: Iterable<string>,
  customPresetNames: Iterable<string> = [],
): { policies: string[]; policyPresetsFinalized: true } {
  const builtins = new Set(builtinPresetNames);
  const custom = new Set(customPresetNames);
  return {
    policies: appliedPolicyPresets.filter((preset) => builtins.has(preset) && !custom.has(preset)),
    policyPresetsFinalized: true,
  };
}

/**
 * Decide the presets to carry into a *recreated* sandbox's session.
 *
 * decidePolicyCarryForward collapses an empty previous list to `null`, after
 * which the policy step falls back to the default tier — re-adding presets a
 * Restricted-tier (or fully-deselected) operator intentionally removed. When
 * the prior policy step was finalized with a genuinely empty selection, honor
 * that empty set too, still deferring to an env override (decideReusePolicyPresets
 * returns `null` for one). Only overrides the base decision when it carried
 * nothing and printed no override note.
 *
 * `hadCustomPolicies` guards the empty-honor: an empty built-in list with
 * recorded custom presets is not an "empty selection" — recreate discards the
 * custom-preset content, so fall back to the prompt rather than silently seeding
 * `[]` and skipping the selector.
 */
export function resolveRecreatePolicyPresets(
  previousPolicies: string[] | null | undefined,
  finalized: boolean,
  hadCustomPolicies: boolean,
  env: PolicyEnv,
  nonInteractive: boolean,
): { policyPresets: string[] | null; overrideNote: string | null } {
  const decision = decidePolicyCarryForward(previousPolicies, env, nonInteractive);
  let policyPresets = decision.newPresets;
  if (
    policyPresets === null &&
    decision.overrideNote === null &&
    finalized &&
    !hadCustomPolicies &&
    Array.isArray(previousPolicies)
  ) {
    policyPresets = decideReusePolicyPresets(previousPolicies, env, nonInteractive);
  }
  return { policyPresets, overrideNote: decision.overrideNote };
}

/**
 * Reuse path (`nemoclaw onboard --name <existing>` without --recreate-sandbox):
 * seed the fresh onboard session's policy presets from the sandbox's recorded
 * applied set so the policy step carries the operator's exact effective
 * selection forward instead of re-prompting with raw tier defaults (which would
 * silently reintroduce a removed Balanced default such as `npm`).
 *
 * Uses the full applied set (built-in `policies` plus custom-preset names) so a
 * preserved custom preset is not diffed away as "deselected", and via
 * decideReusePolicyPresets so an intentionally-empty selection (Restricted tier)
 * is carried as `[]`. Gated on `policyPresetsFinalized` so boot-time-only state
 * from an interrupted run is not mistaken for a final selection, and guarded so
 * an in-progress --resume session is never clobbered.
 */
export function seedReusedSandboxPolicyPresets(
  sandboxName: string,
  nonInteractive: boolean,
  getAppliedPresets: (sandboxName: string) => string[] = defaultGetAppliedPresets,
): void {
  const priorPolicyStepCompleted =
    registry.getSandbox(sandboxName)?.policyPresetsFinalized === true;
  const session = onboardSession.loadSession();
  if (!priorPolicyStepCompleted || Array.isArray(session?.policyPresets)) return;
  const policyPresets = decideReusePolicyPresets(
    getAppliedPresets(sandboxName),
    process.env,
    nonInteractive,
  );
  onboardSession.updateSession((current: Session) => {
    current.policyPresets = policyPresets;
    return current;
  });
}

/**
 * Recreate path: seed the session from the previous entry's recorded selection
 * (carrying forward, or honoring a finalized empty set), then print any env
 * override note. See resolveRecreatePolicyPresets.
 */
export function applyRecreatePolicyCarryForward(
  sandboxName: string,
  nonInteractive: boolean,
  note: (message: string) => void,
): void {
  const previousEntry = registry.getSandbox(sandboxName);
  const { policyPresets, overrideNote } = resolveRecreatePolicyPresets(
    previousEntry?.policies,
    previousEntry?.policyPresetsFinalized === true,
    (previousEntry?.customPolicies?.length ?? 0) > 0,
    process.env,
    nonInteractive,
  );
  onboardSession.updateSession((current: Session) => {
    current.policyPresets = policyPresets;
    return current;
  });
  if (overrideNote !== null) note(overrideNote);
}

/**
 * Persist the operator's effective policy preset selection to the registry once
 * the policy step has fully reconciled it onto the live gateway. Filters to
 * built-in preset names and stamps `policyPresetsFinalized`.
 */
export function persistFinalizedPolicyPresets(
  sandboxName: string,
  appliedPolicyPresets: string[],
  listBuiltinPresetNames: () => string[] = defaultListBuiltinPresetNames,
): void {
  const customPresetNames = registry.getCustomPolicies(sandboxName).map((preset) => preset.name);
  registry.updateSandbox(
    sandboxName,
    buildFinalizedPolicyPresetsUpdate(appliedPolicyPresets, listBuiltinPresetNames(), customPresetNames),
  );
}
