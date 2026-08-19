// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ONBOARD_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const ONBOARD_TEST_TIMEOUT_MS = 40 * 60_000;

// Keep enough time outside the product's final supervisor-reconnect wait for
// the preceding onboarding work and a bounded terminal diagnostic.
export const ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS = 10 * 60_000;
export const ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS = 5 * 60_000;
