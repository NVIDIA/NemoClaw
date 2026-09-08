// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

const SANDBOX_LIFECYCLE_DEFERRED_EXIT = Symbol.for("nemoclaw.sandbox-lifecycle.deferred-exit");

/** Normalize Node exit values while failing closed for present malformed values. */
export function normalizeProcessExitCode(
  value: number | string | null | undefined,
  absentExitCode = 0,
): number {
  if (value === null || value === undefined) return absentExitCode;
  if (value === "") return 1;
  const exitCode = Number(value);
  return Number.isInteger(exitCode) ? exitCode : 1;
}

export class SandboxLifecycleDeferredExit extends Error {
  readonly [SANDBOX_LIFECYCLE_DEFERRED_EXIT] = true;
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Sandbox lifecycle operation requested exit ${String(exitCode)}.`);
    this.name = "SandboxLifecycleDeferredExit";
    this.exitCode = exitCode;
  }
}

/** Carry a terminal CLI result through the lifecycle lock's async cleanup. */
export function deferSandboxLifecycleExit(exitCode: number): never {
  throw new SandboxLifecycleDeferredExit(exitCode);
}

export function isSandboxLifecycleDeferredExit(
  error: unknown,
): error is SandboxLifecycleDeferredExit {
  const candidate = error as
    | (Error & {
        exitCode?: unknown;
        [SANDBOX_LIFECYCLE_DEFERRED_EXIT]?: unknown;
      })
    | null;
  return (
    candidate instanceof Error &&
    candidate[SANDBOX_LIFECYCLE_DEFERRED_EXIT] === true &&
    candidate.name === "SandboxLifecycleDeferredExit" &&
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode)
  );
}

/** Complete an async cleanup boundary before honoring a deferred CLI exit. */
export async function runWithDeferredSandboxLifecycleExit<T>(
  operation: () => Promise<T>,
  exit: (exitCode: number) => never = process.exit,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isSandboxLifecycleDeferredExit(error)) throw error;
    return exit(error.exitCode);
  }
}

export function spawnExitCode(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
}): number {
  if (result.status !== null) return result.status;
  if (!result.signal) return 1;
  const signalNumber = os.constants.signals[result.signal];
  return signalNumber ? 128 + signalNumber : 1;
}
