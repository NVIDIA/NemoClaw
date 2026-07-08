// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isDcodeAgent,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
} from "./observability-policy-presets";
import {
  isOpenclawAgent,
  OPENCLAW_OTEL_LOCAL_POLICY_PRESET,
  requiredOpenclawOtelPolicyPresets,
} from "./openclaw-otel-policy-presets";

export const RESTRICTED_TIER_NAME = "restricted";

export function normalizePolicyTierName(tierName: string | null | undefined): string | null {
  if (typeof tierName !== "string") return null;
  return tierName.trim().toLowerCase() || null;
}

export function agentRequiredPresetAdditions(
  agent: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!isOpenclawAgent(agent)) return [];
  return ["openclaw-pricing", ...requiredOpenclawOtelPolicyPresets(agent, env)];
}

function restrictedIncompatibleAgentRequiredPresets(agent: string | null | undefined): string[] {
  if (isOpenclawAgent(agent)) {
    return ["openclaw-pricing", OPENCLAW_OTEL_LOCAL_POLICY_PRESET];
  }
  if (isDcodeAgent(agent)) return [OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET];
  return [];
}

/**
 * Invalid state: OpenClaw onboarding adds `openclaw-pricing` (and, when
 * `NEMOCLAW_OPENCLAW_OTEL=1` with a local endpoint, `openclaw-diagnostics-otel-local`)
 * to every sandbox as agent-required presets, but the Restricted tier
 * description promises "no third-party network access beyond inference and core
 * agent tooling". The pricing fetch reaches LiteLLM/OpenRouter and the OTEL
 * preset opens host-local OTLP egress, so on Restricted both additions
 * contradict the tier description and the linked issue's zero-applied-preset
 * acceptance. The OTEL preset is restricted-incompatible whenever it is live,
 * not only when the current process has `NEMOCLAW_OPENCLAW_OTEL` set — a
 * restricted re-onboard with OTEL disabled must still classify a previously
 * applied `openclaw-diagnostics-otel-local` as suppressed so the
 * preservation / resume paths remove it instead of leaving stale host-local
 * OTLP egress on a restricted sandbox.
 *
 * Source boundary: the agent-required additions list is hardcoded in this
 * module (and `openclaw-otel-policy-presets.ts`) rather than declared in
 * `nemoclaw-blueprint/policies/tiers.yaml`. Tier YAML can express a tier's
 * default presets but cannot express "this preset is conditionally added by
 * the active agent, except when the tier explicitly suppresses it" — so the
 * suppression must live alongside the addition. The suggestion / addition
 * gate stays env-conditioned via `agentRequiredPresetAdditions()`; the
 * suppression gate is env-independent via
 * `restrictedIncompatibleAgentRequiredPresets()` so live cleanup catches
 * presets applied by a prior process with a different env.
 *
 * Source-fix constraint: tier YAML has no schema for agent-conditional or
 * tier-conditional preset gating, and `requiredOpenclawOtelPolicyPresets()`
 * itself takes `agent` and `env` (OTEL endpoint locality) inputs that the YAML
 * cannot evaluate at parse time.
 *
 * Regression test: `test/policy-tiers-onboard.test.ts` exercises
 * `setupPoliciesWithSelection` end-to-end for restricted + OpenClaw across
 * fresh-onboard, preservation, resume, and OTEL-enabled / OTEL-disabled paths,
 * including stale-applied OTEL-local cleanup with the current env disabled;
 * `test/onboard-policy-suggestions.test.ts` covers
 * `suppressedAgentRequiredPresets` (env-independent) and
 * `computeSetupPresetSuggestions` (env-gated) directly.
 *
 * Removal condition: when the agent-required addition list moves into per-agent
 * declarative metadata (per-preset application-source records in the registry,
 * or per-agent YAML under `nemoclaw-blueprint/policies/`) so the tier filter
 * can be applied at the metadata layer, this module — together with the
 * `tierName` plumbing through `mergeRequiredSetupPolicyPresets()` — can be
 * removed in one pass.
 *
 * Operator escape hatch (defense-in-depth note): suppression is a security
 * boundary, not a default — an operator who explicitly needs `openclaw-pricing`
 * or `openclaw-diagnostics-otel-local` on a restricted sandbox can re-apply
 * either preset on demand via `nemoclaw <sandbox-name> policy-add <preset>`,
 * which the onboard notice emitted by `setupPoliciesWithSelectionInner` also
 * surfaces inline. The env-independent suppression list specifically catches
 * stale presets applied by a prior process with `NEMOCLAW_OPENCLAW_OTEL=1` so
 * the next restricted reconciliation removes them even when the current
 * process has OTEL disabled.
 */
export function suppressedAgentRequiredPresets(
  tierName: string,
  agent: string | null | undefined,
): string[] {
  if (normalizePolicyTierName(tierName) !== RESTRICTED_TIER_NAME) return [];
  return restrictedIncompatibleAgentRequiredPresets(agent);
}

export function filterSuppressedAgentRequiredPresets(
  presetNames: string[],
  tierName: string | null | undefined,
  agent: string | null | undefined,
): string[] {
  if (!tierName) return presetNames;
  const suppressed = new Set(suppressedAgentRequiredPresets(tierName, agent));
  if (suppressed.size === 0) return presetNames;
  return presetNames.filter((name) => !suppressed.has(name));
}

export function emitSuppressedAgentRequiredPresetsNote(
  tierName: string,
  agent: string | null | undefined,
  note: (message: string) => void,
): Set<string> {
  const suppressed = suppressedAgentRequiredPresets(tierName, agent);
  if (suppressed.length > 0) {
    note(
      `  Restricted tier suppresses agent-required preset(s): ${suppressed.join(", ")}. Apply later with 'nemoclaw <name> policy-add <preset>' if needed.`,
    );
  }
  return new Set(suppressed);
}
