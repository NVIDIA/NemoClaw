// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed fail-closed cleanup limits documented in docs/reference/troubleshooting.mdx.
 *
 * Do not source these from the environment: operator-controlled tuning would make the proof that
 * gates a broader compatibility envelope deployment-dependent. A slow host must fail closed or
 * select compatibility before creation rather than weaken the native-to-compatibility handoff.
 */
export const MAX_CLEANUP_ATTEMPTS = 5;
export const STABLE_ABSENCE_CHECKS = 2;
export const CLEANUP_POLL_INTERVAL_MS = 1_000;
