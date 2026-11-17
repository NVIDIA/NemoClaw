// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
} from "../live/common-egress-agent-helpers.ts";

describe("common egress agent retry", () => {
  it("records OpenClaw success after the required scope recovery", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(true);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        passed: false,
        failureClass: "transient-external",
        recoveryRequired: true,
      })
      .mockResolvedValueOnce({ passed: true });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      recover,
      run,
    });

    expect(result.outcome).toBe("passed");
    expect(onEvidence).toHaveBeenCalledWith({
      schemaVersion: 1,
      operation: "common-egress.openclaw-agent",
      owner: "openclaw-agent",
      idempotence: "reconciled-mutation",
      maxAttempts: 3,
      outcome: "passed-after-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          reconciled: true,
          retryScheduled: true,
        },
        { attempt: 2, outcome: "passed", retryScheduled: false },
      ],
    });
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ recoveryRequired: true }), 1);
  });

  it("does not retry a plain OpenClaw transport failure without reconciliation", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(true);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, failureClass: "transient-external" })
      .mockResolvedValueOnce({ passed: true });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotence: "reconciled-mutation",
        outcome: "failed-no-retry",
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            failureClass: "transient-external",
            reconciled: false,
            retryScheduled: false,
          },
        ],
      }),
    );
  });

  it("does not retry when OpenClaw scope recovery fails", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: true,
    });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(result.evidence.attempts).toEqual([
      expect.objectContaining({ reconciled: false, retryScheduled: false }),
    ]);
  });

  it("does not retry when OpenClaw scope recovery throws", async () => {
    const recover = vi.fn().mockRejectedValue(new Error("recovery unavailable"));
    const run = vi.fn().mockResolvedValue({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: true,
    });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence: vi.fn(),
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(result.evidence.attempts).toEqual([
      expect.objectContaining({ reconciled: false, retryScheduled: false }),
    ]);
  });

  it("records a deterministic Hermes failure without retrying", async () => {
    const onEvidence = vi.fn();
    const run = vi.fn().mockResolvedValue({ passed: false, failureClass: "deterministic" });

    const result = await runHermesAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(onEvidence).toHaveBeenCalledWith({
      schemaVersion: 1,
      operation: "common-egress.hermes-agent",
      owner: "hermes-agent",
      idempotence: "read-only",
      maxAttempts: 3,
      outcome: "failed-no-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "deterministic",
          retryScheduled: false,
        },
      ],
    });
  });
});
