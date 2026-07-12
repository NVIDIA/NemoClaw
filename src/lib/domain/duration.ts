// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse human-friendly duration strings into seconds.
 *
 * Supported formats: "5m", "30m", "1h", "90s", "300" (raw seconds).
 * Enforces a maximum of 30 minutes (1800 seconds) per the shields-down
 * security invariant — there is no way to disable the auto-restore timer.
 */

const MAX_SECONDS = 1800; // 30 minutes
const DEFAULT_SECONDS = 300; // 5 minutes

const DURATION_RE = /^(\d+)\s*(s|m|h)?$/i;

const MULTIPLIERS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
};

/**
 * Parse a duration string and return the number of seconds.
 *
 * @throws if the input is empty, not a valid duration, zero, negative, or
 *         exceeds the 30-minute maximum.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Duration cannot be empty");
  }

  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${trimmed}". Use a number with optional suffix: 300, 5m, 30m, 1h`,
    );
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = value * (MULTIPLIERS[unit] ?? 1);

  if (seconds <= 0) {
    throw new Error("Duration must be greater than zero");
  }
  if (seconds > MAX_SECONDS) {
    throw new Error(
      `Duration ${seconds}s exceeds maximum of ${MAX_SECONDS}s (${MAX_SECONDS / 60} minutes)`,
    );
  }

  return seconds;
}

export { MAX_SECONDS, DEFAULT_SECONDS };
