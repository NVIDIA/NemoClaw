// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Node turns any timer delay above this into 1 ms, so a larger timeout fires at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Parse a millisecond timeout from an env value, or return undefined when it is unusable. */
export function parseTimerDelayMs(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : undefined;
}
