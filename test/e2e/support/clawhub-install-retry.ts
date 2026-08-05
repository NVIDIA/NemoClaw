// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ClawHubInstallDisposition = "pass" | "retry" | "fail";

const CLAWHUB_RATE_LIMIT_UNAVAILABLE =
  /^ClawHub \/api\/v1\/packages\/.+ failed \(503\): Rate limit temporarily unavailable$/mu;

export function classifyClawHubInstallAttempt(
  exitCode: number | null,
  output: string,
  attempt: number,
  maxAttempts: number,
): ClawHubInstallDisposition {
  if (exitCode === 0) return "pass";
  return attempt < maxAttempts && CLAWHUB_RATE_LIMIT_UNAVAILABLE.test(output) ? "retry" : "fail";
}
