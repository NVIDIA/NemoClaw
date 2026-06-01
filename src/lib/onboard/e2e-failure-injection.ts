// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Testing-only hook for deterministic E2E resume/repair fault injection. */
export function maybeForceE2eStepFailure(stepName: string): void {
  if (process.env.NEMOCLAW_E2E_FAILURE_INJECTION !== "1") return;
  const forcedStep = (process.env.NEMOCLAW_E2E_FORCE_FAIL_AT_STEP || "").trim();
  if (!forcedStep || forcedStep !== stepName) return;
  console.error(`  [e2e] Forced onboarding failure at step '${stepName}'.`);
  process.exit(1);
}
