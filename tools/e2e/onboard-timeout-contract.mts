// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Docker GPU recreation can wait once before Ready and again after the final
// replacement-container restart.
export const ONBOARD_SUPERVISOR_RECONNECT_WAIT_COUNT = 2;
export const ONBOARD_COMMAND_TIMEOUT_MS = 40 * 60_000;
export const ONBOARD_TEST_TIMEOUT_MS = 50 * 60_000;
export const ONBOARD_TARGET_TIMEOUT_MINUTES = 75;

// Keep enough time outside NemoClaw's supervisor-reconnect waits for image
// creation, readiness checks, and a bounded failure diagnostic.
export const ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS = 10 * 60_000;
export const ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS = 10 * 60_000;

// CleanupRegistry can use 10 minutes. Preserve another 10 minutes for job
// setup, evidence finalization, artifact upload, and authentication cleanup.
export const ONBOARD_JOB_CLEANUP_HEADROOM_MS = 20 * 60_000;
