// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type HermesOneShotExecutionState = "pending" | "completed";

function fail(message: string): never {
  throw new Error(message);
}

export function hermesOneShotExecutionState(
  payload: unknown,
  expectedJobId: string,
): HermesOneShotExecutionState {
  if (!Array.isArray(payload)) fail("Hermes cron execution history is not an array");
  if (payload.length > 1) fail("Hermes cron execution history contains multiple attempts");
  if (payload.length === 0) return "pending";

  const record = payload[0];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return fail("Hermes cron execution history contains an invalid record");
  }
  const execution = record as Record<string, unknown>;
  if (execution.job_id !== expectedJobId) {
    return fail("Hermes cron execution history contains the wrong job");
  }
  if (execution.source !== "builtin") {
    return fail("Hermes cron execution did not use the built-in scheduler");
  }
  switch (execution.status) {
    case "claimed":
    case "running":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
    case "unknown":
      return fail(`Hermes cron execution reached ${execution.status}`);
    default:
      return fail("Hermes cron execution history contains an invalid status");
  }
}
