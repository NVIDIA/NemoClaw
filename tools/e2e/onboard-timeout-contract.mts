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

// The registry post-reboot target also contains environment preparation,
// gateway reconnection, sandbox readiness, and final state validation inside
// its Vitest callback. Each rounded budget contains the configured operation
// ceilings for that phase.
// Preparation allows 14 minutes for environment probes, optional OpenShell
// installation, and gateway-service staging.
export const ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS = 15 * MINUTE_MS;
// Gateway recovery allows 42m15s for Docker transitions, runtime restart,
// reconnect polling, and the terminal service diagnostic.
export const ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS = 45 * MINUTE_MS;
// Sandbox readiness allows 17m25s for all 30 probes and their delays.
export const ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS = 20 * MINUTE_MS;
// Final status and typed state validation allow 8m15s, leaving room for local
// completion evidence before the separate test headroom.
export const ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS = 10 * MINUTE_MS;
export const ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS =
  ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS +
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
  ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS +
  ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS +
  ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS +
  ONBOARD_TEST_HEADROOM_MS;
export const ONBOARD_POST_REBOOT_TARGET_TIMEOUT_MINUTES =
  (ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS;

export type LiveTargetTimeoutContract = Readonly<{
  commandTimeoutMs?: number;
  testTimeoutMs?: number;
  targetTimeoutMinutes: number;
}>;

export function liveTargetTimeoutContract(
  lifecycle: string | undefined,
): LiveTargetTimeoutContract {
  return lifecycle === "post-reboot-recovery"
    ? {
        commandTimeoutMs: ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
        testTimeoutMs: ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS,
        targetTimeoutMinutes: ONBOARD_POST_REBOOT_TARGET_TIMEOUT_MINUTES,
      }
    : { targetTimeoutMinutes: 45 };
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
