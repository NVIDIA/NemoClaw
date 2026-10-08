// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** One monotonic allowance shared by the commands and waits of an owning operation. */
export function createOpenShellOperationDeadline(
  timeoutMs: number,
  now: () => number = () => performance.now(),
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenShell operation allowance must be finite and positive");
  }
  let previous = now();
  const deadline = previous + timeoutMs;
  if (!Number.isFinite(previous) || !Number.isFinite(deadline)) {
    throw new Error("OpenShell operation clock is invalid");
  }
  return Object.freeze({
    remaining(maximumMs: number, phase: string): number {
      const current = now();
      if (!Number.isFinite(current) || current < previous) {
        throw new Error("OpenShell operation clock moved backwards or became invalid");
      }
      previous = current;
      const remaining = Math.floor(deadline - current);
      if (remaining <= 0)
        throw new Error(`OpenShell operation allowance exhausted during ${phase}`);
      return Math.min(maximumMs, remaining);
    },
  });
}
