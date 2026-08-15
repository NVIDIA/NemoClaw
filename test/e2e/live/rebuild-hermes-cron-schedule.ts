// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const RECOVERY_CRON_DELAY_MS = 10_000;

export function buildHermesRecoveryCronSchedule(nowMs = Date.now()): {
  runAt: string;
  runAtMs: number;
} {
  const runAtMs = nowMs + RECOVERY_CRON_DELAY_MS;
  return { runAt: new Date(runAtMs).toISOString(), runAtMs };
}
