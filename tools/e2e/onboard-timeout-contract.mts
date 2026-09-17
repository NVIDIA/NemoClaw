// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const MINUTE_MS = 60_000;
const ONBOARD_TEST_HEADROOM_MS = 10 * MINUTE_MS;
const ONBOARD_JOB_HEADROOM_MS = 20 * MINUTE_MS;

// The Docker recreation path can wait once before `Ready` and again after the final
// replacement-container restart. The outer command must contain both waits
// plus image creation, readiness checks, and a bounded failure diagnostic.
export const ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS = 40 * MINUTE_MS;
export const ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS = 15 * MINUTE_MS;

export const ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS =
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS + ONBOARD_TEST_HEADROOM_MS;
export const ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES = 75;

// The typed DCode target runs onboarding, its invalid-credential lifecycle,
// state validation, and the ordered cloud checks. Those checks can consume 96
// minutes of command deadlines; retain the same 20-minute job headroom used by
// the catalogue timeout contracts after the complete test budget.
export const DCODE_TYPED_TARGET_TEST_TIMEOUT_MS = 130 * MINUTE_MS;
export const DCODE_TYPED_TARGET_TIMEOUT_MINUTES =
  (DCODE_TYPED_TARGET_TEST_TIMEOUT_MS + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS;

export type LiveTargetTimeoutContract = Readonly<{
  commandTimeoutMs?: number;
  testTimeoutMs?: number;
  targetTimeoutMinutes: number;
}>;

export function liveTargetTimeoutContract(
  lifecycle: string | undefined,
): LiveTargetTimeoutContract {
  if (lifecycle === "dcode-rebuild-invalid-credential") {
    return {
      testTimeoutMs: DCODE_TYPED_TARGET_TEST_TIMEOUT_MS,
      targetTimeoutMinutes: DCODE_TYPED_TARGET_TIMEOUT_MINUTES,
    };
  }
  return { targetTimeoutMinutes: 45 };
}

// The onboard-resume scenario gives two create/recreate commands the
// final-handoff deadline. Four later commands use the no-recreate deadline and
// assert sandbox reuse or preflight failure.
export const ONBOARD_RESUME_TEST_TIMEOUT_MS =
  2 * ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
  4 * ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS +
  ONBOARD_TEST_HEADROOM_MS;
export const ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES =
  (ONBOARD_RESUME_TEST_TIMEOUT_MS + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS;
