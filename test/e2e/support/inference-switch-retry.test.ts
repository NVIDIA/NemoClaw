// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  inferenceSetAttemptCount,
  runInferenceSetWithRetry,
} from "../fixtures/inference-switch-retry.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

function result(exitCode: number, stderr = ""): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode,
    signal: null,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

describe("inference switch retry", () => {
  it("retries transient verification failures and preserves verification", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1, "failed to verify inference endpoint: timeout"))
      .mockResolvedValueOnce(result(0));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(runInferenceSetWithRetry({ attempts: 3, delay, run })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(run.mock.calls).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(delay).toHaveBeenCalledWith(5_000);
  });

  it("uses no-verify only after the transient verification budget is exhausted", async () => {
    const transient = result(1, "failed to connect to endpoint");
    const run = vi
      .fn()
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(result(0));

    await expect(
      runInferenceSetWithRetry({ attempts: 2, delay: async () => {}, run }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(run.mock.calls).toEqual([
      [1, true],
      [2, true],
      [2, false],
    ]);
  });

  it("does not bypass non-transient verification failures", async () => {
    const run = vi.fn().mockResolvedValue(result(1, "invalid provider"));

    await expect(
      runInferenceSetWithRetry({ attempts: 3, delay: async () => {}, run }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(1, true);
  });

  it("validates the configured attempt count", () => {
    expect(inferenceSetAttemptCount(undefined)).toBe(3);
    expect(inferenceSetAttemptCount("2")).toBe(2);
    expect(() => inferenceSetAttemptCount("0")).toThrow(/positive integer/u);
  });
});
