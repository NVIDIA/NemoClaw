// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExportExpectation } from "../../test/e2e/registry/types.ts";
import { testTimeout } from "../../test/helpers/timeouts.ts";

const MINUTE_MS = 60_000;
const ONBOARD_TEST_HEADROOM_MS = 10 * MINUTE_MS;
const ONBOARD_JOB_HEADROOM_MS = 20 * MINUTE_MS;
export const LIVE_TARGET_BASE_TEST_TIMEOUT_MS = 30 * MINUTE_MS;
export const CONFIG_EXPORT_COMMAND_TIMEOUT_MS = 2 * MINUTE_MS;
export const CONFIG_EXPORT_POLICY_TIMEOUT_MS = MINUTE_MS;
// Contains the pinned consumer's 30-second archive, 30-second extraction,
// eight-minute Cargo, and 30-second native-settings deadlines.
export const CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS = 10 * MINUTE_MS;

// The Deep Agents Code credential-rotation lifecycle performs three bounded
// route polls around provider mutation, a bounded rejected rebuild, container
// identity checks, marker checks, and credential restoration. The ordinary
// live-target base retains environment preparation, onboarding, and final
// state validation; this budget contains the additional lifecycle operations.
export const DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS = 20 * MINUTE_MS;

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
// minutes of command deadlines before automatic config export; retain the same
// 20-minute job headroom used by the catalogue timeout contracts after the
// complete test budget.
export const DCODE_TYPED_TARGET_TEST_TIMEOUT_MS = 130 * MINUTE_MS;
export const DCODE_TYPED_TARGET_TIMEOUT_MINUTES =
  (DCODE_TYPED_TARGET_TEST_TIMEOUT_MS + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS;

export type LiveTargetTimeoutContract = Readonly<{
  commandTimeoutMs?: number;
  testTimeoutMs?: number;
  targetTimeoutMinutes: number;
}>;

const CONFIG_EXPORT_BUDGET_MS: Readonly<Record<ConfigExportExpectation, number>> = {
  required:
    CONFIG_EXPORT_COMMAND_TIMEOUT_MS +
    CONFIG_EXPORT_POLICY_TIMEOUT_MS +
    CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS,
  "expected-refusal": CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
  "no-usable-sandbox": 0,
};

function configExportBudgetMs(expectation: ConfigExportExpectation): number {
  if (!Object.hasOwn(CONFIG_EXPORT_BUDGET_MS, expectation)) {
    throw new Error("Unknown config export expectation");
  }
  return CONFIG_EXPORT_BUDGET_MS[expectation];
}

export function liveTargetTimeoutContract(
  lifecycle: string | undefined,
  configExportExpectation: ConfigExportExpectation,
): LiveTargetTimeoutContract {
  const configExportBudget = configExportBudgetMs(configExportExpectation);
  if (lifecycle === "dcode-rebuild-invalid-credential") {
    const testTimeoutMs = testTimeout(DCODE_TYPED_TARGET_TEST_TIMEOUT_MS + configExportBudget);
    return {
      testTimeoutMs,
      targetTimeoutMinutes: Math.ceil((testTimeoutMs + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS),
    };
  }
  if (configExportBudget === 0) return { targetTimeoutMinutes: 45 };
  const testTimeoutMs = testTimeout(LIVE_TARGET_BASE_TEST_TIMEOUT_MS + configExportBudget);
  return {
    testTimeoutMs,
    targetTimeoutMinutes: Math.ceil((testTimeoutMs + ONBOARD_JOB_HEADROOM_MS) / MINUTE_MS),
  };
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
