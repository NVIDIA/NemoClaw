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

const GOOGLECHAT_CHANNELS_STOP_START_SANDBOX = "e2e-channels-stop-start-openclaw";

/**
 * Test-only composition seam for the protected live channel lifecycle target.
 *
 * Keep this exact and fail closed: the Google Chat enrollment hook itself does
 * not read an environment bypass, and ordinary onboarding never receives the
 * injected exception.
 */
export function allowGooglechatPresetAudienceForLiveE2e(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NEMOCLAW_RUN_LIVE_E2E === "1" &&
    env.NEMOCLAW_E2E_ALLOW_GOOGLECHAT_PRESET_AUDIENCE === "1" &&
    env.E2E_TARGET_ID === "channels-stop-start" &&
    sandboxName === GOOGLECHAT_CHANNELS_STOP_START_SANDBOX
  );
}
