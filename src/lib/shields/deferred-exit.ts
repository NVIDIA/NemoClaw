// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sentinel thrown in place of process.exit while a shields transition lock is
 * active: process.exit skips finally blocks and would strand the canonical
 * lock. Public command wrappers translate the sentinel into an exit code once
 * every lock has been released (NemoClawCommand.catch).
 *
 * Kept in a leaf module so the CLI base command can guard against the
 * sentinel without loading the shields coordinator, and so tests that mock
 * the shields module keep the real guard.
 */
export class DeferredShieldsExit extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "DeferredShieldsExit";
    this.exitCode = exitCode;
  }
}

/**
 * Name-keyed guard: instanceof breaks when dist and src copies of the class
 * are both loaded, so match on the sentinel's shape instead (same pattern as
 * snapshotCommandError).
 */
export function isDeferredShieldsExit(error: unknown): error is DeferredShieldsExit {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; exitCode?: unknown };
  return candidate.name === "DeferredShieldsExit" && typeof candidate.exitCode === "number";
}
