// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  resolvePrimaryMessagingCredentialEnvKeys,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "./sandbox-create-intent";
export type {
  MaterializeSandboxCreatePlanInput,
  ResolveSandboxCreateIntentInput,
  SandboxCreateIntent,
  SandboxCreateMessagingProviderRequest,
  SandboxCreatePolicyRequest,
} from "./sandbox-create-intent-types";
export type { SandboxCreatePlan } from "./sandbox-create-plan-materialization";
export {
  materializeSandboxCreatePlan,
  prepareSandboxCreatePolicy,
  validateSandboxCreateIntentBindings,
} from "./sandbox-create-plan-materialization";

// Known canonical policy tier names. Kept inline so the create-time path
// validates the env value without pulling `../policy/tiers` (which transitively
// requires `runner.ts` and breaks vitest source resolution for this module's
// tests). The list mirrors `nemoclaw-blueprint/policies/tiers.yaml`; adding a
// tier there requires updating this set so an explicit tier env value reaches
// the create-time policy decision.
const KNOWN_POLICY_TIER_NAMES = new Set(["restricted", "balanced", "open", "personal"]);

export function resolveSandboxCreatePolicyTier(requestedPolicyTier?: string | null): string | null {
  if (requestedPolicyTier !== undefined) return requestedPolicyTier;
  // Only trust the env value in non-interactive mode. Interactive flows let the
  // operator override the tier via the selector after sandbox creation; if the
  // env said balanced but the operator picks restricted, an interactive trust
  // of the env would have already let create-time OTEL through. Fail closed:
  // interactive mode returns null so the OTEL preset is deferred to the
  // post-boot policy step.
  const isNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  if (!isNonInteractive) return null;
  const raw = process.env.NEMOCLAW_POLICY_TIER;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return KNOWN_POLICY_TIER_NAMES.has(trimmed) ? trimmed : null;
}
