// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getTier, listTiers } from "../policy/tiers";

/**
 * Resolve NEMOCLAW_POLICY_TIER from the environment. Returns the
 * normalized name (defaulting to `"balanced"` when the env var is unset
 * or blank). Exits with status 1 on a known-set, non-blank, unknown
 * value, listing the accepted options. Pure aside from `process.exit`,
 * so callers can run it early in onboard() to honor the fail-fast
 * contract documented in commands.md (#3741).
 */
export function resolvePolicyTierFromEnv(): string {
  const raw = process.env.NEMOCLAW_POLICY_TIER;
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const name = trimmed || "balanced";
  if (!getTier(name)) {
    console.error(
      `  Unknown policy tier: ${name}. Valid: ${listTiers().map((t) => t.name).join(", ")}`,
    );
    process.exit(1);
  }
  return name;
}

/**
 * Early gate intended for the top of onboard(): runs the validation
 * only when the env var is explicitly set to a non-blank value, so the
 * absence-of-env-var default still flows through to the interactive
 * prompt. A blank/whitespace value is treated the same as unset (#3741).
 */
export function validatePolicyTierEnvEarly(): void {
  const raw = process.env.NEMOCLAW_POLICY_TIER;
  if (typeof raw === "string" && raw.trim() !== "") {
    resolvePolicyTierFromEnv();
  }
}
