// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  RetryPolicyError,
  runBoundedRetry,
  validateRetryEvidence,
} from "../../../tools/e2e/retry-evidence.mts";

describe("serialized retry evidence", () => {
  it("accepts evidence whose attempt history matches its aggregate outcome", () => {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      outcome: "passed-after-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          retryScheduled: true,
        },
        { attempt: 2, outcome: "passed", retryScheduled: false },
      ],
    });

    expect(validateRetryEvidence(JSON.parse(serialized))).toMatchObject({
      outcome: "passed-after-retry",
      attempts: [{ retryScheduled: true }, { outcome: "passed" }],
    });
  });

  it("projects validated evidence onto canonical fields", () => {
    const evidence = validateRetryEvidence({
      schemaVersion: 1,
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 1,
      outcome: "failed-no-retry",
      credential: "must-not-survive-validation",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "deterministic",
          retryScheduled: false,
          diagnostic: "must-not-survive-validation",
        },
      ],
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 1,
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
    expect(JSON.stringify(evidence)).not.toContain("must-not-survive-validation");
  });

  it.each([
    {
      name: "a successful attempt with failure metadata",
      change: {
        attempts: [
          { attempt: 1, outcome: "passed", failureClass: "cleanup", retryScheduled: false },
        ],
      },
    },
    {
      name: "a retry after a deterministic failure",
      change: {
        maxAttempts: 2,
        outcome: "passed-after-retry",
        attempts: [
          { attempt: 1, outcome: "failed", failureClass: "deterministic", retryScheduled: true },
          { attempt: 2, outcome: "passed", retryScheduled: false },
        ],
      },
    },
    {
      name: "a first-attempt outcome with two attempts",
      change: {
        maxAttempts: 2,
        outcome: "passed-first-attempt",
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            failureClass: "transient-external",
            retryScheduled: true,
          },
          { attempt: 2, outcome: "passed", retryScheduled: false },
        ],
      },
    },
    {
      name: "an exhausted outcome before the attempt budget ends",
      change: { maxAttempts: 2, outcome: "exhausted" },
    },
    {
      name: "an exhausted outcome after a deterministic final failure",
      change: {
        maxAttempts: 2,
        outcome: "exhausted",
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            failureClass: "transient-external",
            retryScheduled: true,
          },
          { attempt: 2, outcome: "failed", failureClass: "deterministic", retryScheduled: false },
        ],
      },
    },
    {
      name: "a no-retry outcome after exhausting transient attempts",
      change: {
        maxAttempts: 2,
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            failureClass: "transient-external",
            retryScheduled: true,
          },
          {
            attempt: 2,
            outcome: "failed",
            failureClass: "transient-external",
            retryScheduled: false,
          },
        ],
      },
    },
    {
      name: "a reconciled mutation without reconciliation evidence",
      change: { idempotence: "reconciled-mutation", maxAttempts: 2 },
    },
  ])("rejects serialized evidence with $name", ({ change }) => {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 1,
      outcome: "failed-no-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          retryScheduled: false,
        },
      ],
      ...change,
    });

    expect(validateRetryEvidence(JSON.parse(serialized))).toBeNull();
  });
});

describe("bounded E2E operation retry policy", () => {
  it("reports a first-attempt pass", async () => {
    const result = await runBoundedRetry({
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 3,
      run: async () => "ok",
      classify: (value) =>
        value === "ok"
          ? { outcome: "passed" }
          : { outcome: "failed", failureClass: "deterministic" },
    });

    expect(result.outcome).toBe("passed");
    expect(result.evidence).toMatchObject({
      outcome: "passed-first-attempt",
      attempts: [{ attempt: 1, outcome: "passed" }],
    });
  });

  it("records transient recovery without hiding the first failure", async () => {
    const run = vi.fn().mockResolvedValueOnce("timeout").mockResolvedValueOnce("ok");
    const evidence: unknown[] = [];
    const result = await runBoundedRetry({
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 3,
      run,
      classify: (value) =>
        value === "ok"
          ? { outcome: "passed" }
          : { outcome: "failed", failureClass: "transient-external" },
      onEvidence: (record) => {
        evidence.push(record);
      },
    });

    expect(result.evidence.outcome).toBe("passed-after-retry");
    expect(result.evidence.attempts).toEqual([
      { attempt: 1, outcome: "failed", failureClass: "transient-external", retryScheduled: true },
      { attempt: 2, outcome: "passed", retryScheduled: false },
    ]);
    expect(evidence).toEqual([result.evidence]);
  });

  it.each([
    "authentication",
    "authorization",
    "policy-denial",
    "malformed-input",
    "deterministic",
  ] as const)("does not retry %s failures", async (failureClass) => {
    const run = vi.fn().mockResolvedValue("failed");
    const result = await runBoundedRetry({
      operation: "provider.probe",
      owner: "nemoclaw",
      idempotence: "read-only",
      maxAttempts: 3,
      run,
      classify: () => ({ outcome: "failed", failureClass }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.evidence.outcome).toBe("failed-no-retry");
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an exhausted transient retry failed with complete history", async () => {
    const result = await runBoundedRetry({
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 2,
      run: async () => "timeout",
      classify: () => ({ outcome: "failed", failureClass: "transient-external" }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.evidence.outcome).toBe("exhausted");
    expect(result.evidence.attempts).toHaveLength(2);
    expect(result.evidence.attempts[1]?.retryScheduled).toBe(false);
  });

  it("uses the computed bounded delay between transient attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runBoundedRetry({
      operation: "provider.probe",
      owner: "external-provider",
      idempotence: "read-only",
      maxAttempts: 3,
      delayMs: (attempt) => attempt * 1_000,
      sleep,
      run: async () => "timeout",
      classify: () => ({ outcome: "failed", failureClass: "transient-external" }),
    });

    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it("rejects a retry delay outside the bounded range", async () => {
    await expect(
      runBoundedRetry({
        operation: "provider.probe",
        owner: "external-provider",
        idempotence: "read-only",
        maxAttempts: 2,
        delayMs: 300_001,
        sleep: async () => {},
        run: async () => "timeout",
        classify: () => ({ outcome: "failed", failureClass: "transient-external" }),
      }),
    ).rejects.toThrow("between 0 and 300000");
  });

  it("requires reconciliation before retrying an ambiguous mutation", async () => {
    const run = vi.fn().mockResolvedValue("timeout");
    const result = await runBoundedRetry({
      operation: "sandbox.mutate",
      owner: "nemoclaw",
      idempotence: "reconciled-mutation",
      maxAttempts: 3,
      run,
      classify: () => ({ outcome: "failed", failureClass: "transient-external" }),
      reconcile: async () => false,
    });

    expect(result.evidence.outcome).toBe("failed-no-retry");
    expect(result.evidence.attempts[0]?.reconciled).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("retries a mutation only after reconciliation authorizes it", async () => {
    const run = vi.fn().mockResolvedValueOnce("timeout").mockResolvedValueOnce("ok");
    const reconcile = vi.fn().mockResolvedValue(true);
    const result = await runBoundedRetry({
      operation: "sandbox.mutate",
      owner: "nemoclaw",
      idempotence: "reconciled-mutation",
      maxAttempts: 2,
      run,
      classify: (value) =>
        value === "ok"
          ? { outcome: "passed" }
          : { outcome: "failed", failureClass: "transient-external" },
      reconcile,
    });

    expect(result.evidence.outcome).toBe("passed-after-retry");
    expect(result.evidence.attempts[0]?.reconciled).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("keeps cleanup failures visible and excludes exception text from evidence", async () => {
    const secret = "nvapi-secret-value";
    let caught: RetryPolicyError | undefined;
    try {
      await runBoundedRetry({
        operation: "sandbox.cleanup",
        owner: "nemoclaw",
        idempotence: "idempotent",
        maxAttempts: 3,
        run: async () => {
          throw new Error(`cleanup failed with ${secret}`);
        },
        classify: () => ({ outcome: "failed", failureClass: "cleanup" }),
      });
    } catch (error) {
      caught = error as RetryPolicyError;
    }

    expect(caught).toBeInstanceOf(RetryPolicyError);
    expect(caught?.evidence.outcome).toBe("failed-no-retry");
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught?.evidence)).not.toContain(secret);
  });

  it("preserves exhaustion when a bounded retry ends in cleanup failure", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary transport failure"))
      .mockRejectedValueOnce(new Error("cleanup failed"));
    let caught: RetryPolicyError | undefined;
    try {
      await runBoundedRetry({
        operation: "sandbox.cleanup",
        owner: "nemoclaw",
        idempotence: "idempotent",
        maxAttempts: 2,
        run,
        classify: (_value, error) => ({
          outcome: "failed",
          failureClass:
            error instanceof Error && error.message === "temporary transport failure"
              ? "transient-external"
              : "cleanup",
        }),
      });
    } catch (error) {
      caught = error as RetryPolicyError;
    }

    expect(caught).toBeInstanceOf(RetryPolicyError);
    expect(caught?.evidence).toMatchObject({
      outcome: "exhausted",
      attempts: [
        { failureClass: "transient-external", retryScheduled: true },
        { failureClass: "cleanup", retryScheduled: false },
      ],
    });
  });

  it("rejects malformed policy bounds before running", async () => {
    const run = vi.fn();
    await expect(
      runBoundedRetry({
        operation: "provider.probe",
        owner: "nemoclaw",
        idempotence: "read-only",
        maxAttempts: 0,
        run,
        classify: () => ({ outcome: "passed" }),
      }),
    ).rejects.toThrow("between 1 and 10");
    expect(run).not.toHaveBeenCalled();
  });
});
