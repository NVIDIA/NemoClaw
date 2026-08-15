// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { hermesOneShotExecutionState } from "../live/rebuild-hermes-cron-execution.ts";

const jobId = "job-1";

function execution(status: string, overrides: Record<string, unknown> = {}) {
  return { job_id: jobId, source: "builtin", status, ...overrides };
}

describe("Hermes rebuild one-shot cron execution", () => {
  it("reports a pending job before the scheduler claims it", () => {
    expect(hermesOneShotExecutionState([], jobId)).toBe("pending");
  });

  it.each(["claimed", "running"])("reports a %s scheduler attempt as pending", (status) => {
    expect(hermesOneShotExecutionState([execution(status)], jobId)).toBe("pending");
  });

  it("reports a completed scheduler attempt", () => {
    expect(hermesOneShotExecutionState([execution("completed")], jobId)).toBe("completed");
  });

  it.each(["failed", "unknown"])("rejects a %s scheduler attempt", (status) => {
    expect(() => hermesOneShotExecutionState([execution(status)], jobId)).toThrow(
      `Hermes cron execution reached ${status}`,
    );
  });

  it("rejects a direct manual execution", () => {
    expect(() =>
      hermesOneShotExecutionState([execution("completed", { source: "direct" })], jobId),
    ).toThrow("Hermes cron execution did not use the built-in scheduler");
  });

  it("rejects duplicate attempts", () => {
    expect(() =>
      hermesOneShotExecutionState([execution("completed"), execution("completed")], jobId),
    ).toThrow("Hermes cron execution history contains multiple attempts");
  });

  it.each([
    ["non-array payload", {}, "is not an array"],
    ["non-object record", [null], "invalid record"],
    ["wrong job", [execution("completed", { job_id: "job-2" })], "wrong job"],
    ["unsupported status", [execution("cancelled")], "invalid status"],
  ])("rejects %s", (_label, payload, message) => {
    expect(() => hermesOneShotExecutionState(payload, jobId)).toThrow(message);
  });
});
