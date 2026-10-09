// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  inferenceResponseModel,
  inferenceSetAttemptCount,
  isTransientInferenceSetFailure,
  runInferenceSetWithRetry,
  writeInferenceSwitchRetryEvidence,
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
  it("reads only the top-level response model used for route proof", () => {
    expect(inferenceResponseModel('{"model":"target-model"}')).toBe("target-model");
    expect(inferenceResponseModel('{"model":null}')).toBe("");
    expect(inferenceResponseModel('{"choices":[{"model":"nested-model"}]}')).toBe("");
  });

  it("retries transient verification failures and preserves verification", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1, "failed to verify inference endpoint: timeout"))
      .mockResolvedValueOnce(result(0));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(runInferenceSetWithRetry({ attempts: 3, delay, run })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(run.mock.calls).toEqual([[1], [2]]);
    expect(delay).toHaveBeenCalledWith(5_000);
  });

  it("retains degraded evidence when a transient verification passes after retry", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1, "failed to verify inference endpoint: timeout"))
      .mockResolvedValueOnce(result(0));
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");

    await runInferenceSetWithRetry({
      attempts: 2,
      delay: async () => {},
      run,
      onEvidence: (evidence) => writeInferenceSwitchRetryEvidence({ writeJson }, evidence),
    });

    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({
        outcome: "passed-after-retry",
        attempts: [
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: true }),
          expect.objectContaining({ outcome: "passed", retryScheduled: false }),
        ],
      }),
    );
  });

  it("keeps exhausted verified attempts failed without bypassing verification", async () => {
    const transient = result(1, "failed to connect to endpoint");
    const run = vi.fn().mockResolvedValueOnce(transient).mockResolvedValueOnce(transient);
    const writeJson = vi.fn().mockResolvedValue("inference-switch-retry-evidence.json");

    await expect(
      runInferenceSetWithRetry({
        attempts: 2,
        delay: async () => {},
        onEvidence: (evidence) => writeInferenceSwitchRetryEvidence({ writeJson }, evidence),
        run,
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(run.mock.calls).toEqual([[1], [2]]);
    expect(writeJson).toHaveBeenCalledWith(
      "inference-switch-retry-evidence.json",
      expect.objectContaining({
        outcome: "exhausted",
        attempts: [
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: true }),
          expect.objectContaining({ failureClass: "transient-external", retryScheduled: false }),
        ],
      }),
    );
  });

  it("records one deterministic attempt for a terminal verification failure", async () => {
    const run = vi.fn().mockResolvedValue(result(1, "invalid provider"));
    const evidence: unknown[] = [];

    await expect(
      runInferenceSetWithRetry({
        attempts: 3,
        delay: async () => {},
        run,
        onEvidence: (value) => {
          evidence.push(value);
        },
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(run.mock.calls).toEqual([[1]]);
    expect(evidence).toEqual([
      expect.objectContaining({
        outcome: "failed-no-retry",
        attempts: [
          expect.objectContaining({
            attempt: 1,
            failureClass: "deterministic",
            retryScheduled: false,
          }),
        ],
      }),
    ]);
  });

  it("does not retry a deterministic verification mismatch", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(result(1, "failed to verify inference endpoint: model mismatch"));

    await runInferenceSetWithRetry({ attempts: 3, delay: async () => {}, run });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps mixed terminal verification failures out of the TypeScript retry path", () => {
    expect(isTransientInferenceSetFailure(result(1, "authentication failed after timeout"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "authorization failed after ECONNRESET"))).toBe(
      false,
    );
    expect(
      isTransientInferenceSetFailure(result(1, "denied by network policy after ETIMEDOUT")),
    ).toBe(false);
    expect(isTransientInferenceSetFailure(result(1, "malformed request after timeout"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "model mismatch after timeout"))).toBe(false);
    expect(isTransientInferenceSetFailure(result(1, "route mismatch after ECONNRESET"))).toBe(
      false,
    );
    expect(isTransientInferenceSetFailure(result(1, "verification mismatch after timeout"))).toBe(
      false,
    );
  });

  it("validates the configured attempt count", () => {
    expect(inferenceSetAttemptCount(undefined)).toBe(3);
    expect(inferenceSetAttemptCount("2")).toBe(2);
    expect(() => inferenceSetAttemptCount("0")).toThrow(/between 1 and 10/u);
    expect(() => inferenceSetAttemptCount("11")).toThrow(/between 1 and 10/u);
  });
});
