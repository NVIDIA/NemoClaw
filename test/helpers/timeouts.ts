// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function envAwareTimeout(envName: string, defaultMs: number): number {
  const override = parsePositiveInt(process.env[envName]);
  // Treat env values as a minimum budget. That lets slower environments such as
  // WSL raise timeout ceilings without accidentally shortening genuinely slow
  // tests that need a larger explicit budget.
  return override === null ? defaultMs : Math.max(defaultMs, override);
}

export function execTimeout(defaultMs = DEFAULT_EXEC_TIMEOUT_MS): number {
  return envAwareTimeout("NEMOCLAW_EXEC_TIMEOUT", defaultMs);
}

export function testTimeout(defaultMs = DEFAULT_TEST_TIMEOUT_MS): number {
  return envAwareTimeout("NEMOCLAW_TEST_TIMEOUT", defaultMs);
}

export function testTimeoutOptions(defaultMs = DEFAULT_TEST_TIMEOUT_MS): { timeout: number } {
  return { timeout: testTimeout(defaultMs) };
}
