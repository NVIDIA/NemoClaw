// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HostCliClient } from "../fixtures/clients/host.ts";

const MINUTE = 60_000;
export const PROTECTED_RUNTIME_JOB_MINUTES = 75;
export const PROTECTED_RUNTIME_CLEANUP_MS = 5 * MINUTE;
export const PROTECTED_RUNTIME_EVIDENCE_MS = 8 * MINUTE;
export const PROTECTED_RUNTIME_RUNNER_HEADROOM_MS = 2 * MINUTE;
export const PROTECTED_RUNTIME_ROLLBACK_MS = 15 * MINUTE;
const BODY_MS =
  PROTECTED_RUNTIME_JOB_MINUTES * MINUTE -
  PROTECTED_RUNTIME_CLEANUP_MS -
  PROTECTED_RUNTIME_EVIDENCE_MS -
  PROTECTED_RUNTIME_RUNNER_HEADROOM_MS;

export function protectedRuntimeDeadlines(startedAt: string | undefined, now = Date.now()) {
  const start = Number(startedAt);
  if (!Number.isSafeInteger(start) || start <= 0 || start > now) {
    throw new Error("protected runtime job start must be a past epoch millisecond timestamp");
  }
  if (now >= start + BODY_MS - PROTECTED_RUNTIME_ROLLBACK_MS) {
    throw new Error(
      "protected runtime setup exhausted the provider budget; qualification was not started",
    );
  }
  return {
    providers: start + BODY_MS - PROTECTED_RUNTIME_ROLLBACK_MS,
    rollback: start + BODY_MS,
    testTimeoutMs: Math.max(1, start + BODY_MS - now),
  };
}

// Preserve each command's failure guard while sharing the suite's remaining
// wall-clock budget. The underlying ShellProbe owns process-group termination
// and artifact capture; cleanup uses the original host with its own signal.
export function protectedRuntimeDeadlineHost(
  host: Pick<HostCliClient, "command">,
  deadline: number,
  now = Date.now,
): HostCliClient {
  return new HostCliClient({
    async run(command, options = {}) {
      const remaining = deadline - now();
      // Leave the existing supervisor's termination grace inside the deadline.
      const killGraceMs = options.killGraceMs ?? 5_000;
      if (remaining <= killGraceMs) {
        throw new Error(
          "protected runtime suite deadline exhausted; reserved cleanup and evidence remain",
        );
      }
      const result = await host.command(command.command, [...command.args], {
        ...options,
        killGraceMs,
        timeoutMs: Math.min(options.timeoutMs ?? 60_000, remaining - killGraceMs),
      });
      if (result.timedOut || now() >= deadline) {
        throw new Error(
          `protected runtime command exceeded its budget; see ${result.artifacts.result}`,
        );
      }
      return result;
    },
  });
}
