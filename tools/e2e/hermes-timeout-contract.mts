// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMES_TIMEOUT_HEADROOM_MINUTES = 15;
export const HERMES_TIMEOUT_HEADROOM_MAX_MINUTES = 30;

export const HERMES_E2E_TEST_TIMEOUT_MINUTES = 70;
export const HERMES_DISCORD_TEST_TIMEOUT_MINUTES = 75;

export const HERMES_E2E_TEST_TIMEOUT_MS = HERMES_E2E_TEST_TIMEOUT_MINUTES * 60_000;
export const HERMES_DISCORD_TEST_TIMEOUT_MS = HERMES_DISCORD_TEST_TIMEOUT_MINUTES * 60_000;

export const HERMES_TIMEOUT_CONTRACTS = [
  {
    innerTest: "test/e2e/live/hermes-e2e.test.ts",
    innerTimeoutMinutes: HERMES_E2E_TEST_TIMEOUT_MINUTES,
    jobName: "hermes-e2e",
    jobTimeoutMinutes: HERMES_E2E_TEST_TIMEOUT_MINUTES + HERMES_TIMEOUT_HEADROOM_MINUTES,
  },
] as const;
