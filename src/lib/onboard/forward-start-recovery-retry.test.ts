// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBackgroundForwardStartWithReadinessRetry } from "./forward-start";
import * as tempFiles from "./temp-files";

const SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC = `Error:   × code: 'The system is not in a state required for the operation's
  │ execution', message: "sandbox is not ready"
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runBackgroundForwardStartWithReadinessRetry", () => {
  it("retries the readiness handoff until OpenShell accepts the forward", () => {
    const rejections = [SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC, SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC];
    const runForwardStart = vi.fn((stdio: "ignore" | ["ignore", number, number]) => {
      const diagnostic = rejections.shift() ?? "";
      fs.writeSync((stdio as ["ignore", number, number])[1], diagnostic);
      return { status: Number(diagnostic !== "") };
    });

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => false,
      isRetryAllowed: () => true,
      sleepMs: () => {},
    });

    expect(outcome.status).toBe(0);
    expect(runForwardStart).toHaveBeenCalledTimes(3);
  });

  it("stops retrying as soon as the caller withdraws permission", () => {
    const runForwardStart = vi.fn((stdio: "ignore" | ["ignore", number, number]) => {
      fs.writeSync((stdio as ["ignore", number, number])[1], SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC);
      return { status: 1 };
    });

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => false,
      isRetryAllowed: () => false,
      sleepMs: () => {},
    });

    expect(outcome.status).toBe(1);
    expect(outcome.failureReason).toBe("retry-not-allowed");
    expect(runForwardStart).toHaveBeenCalledOnce();
  });

  it.each([
    {
      diagnostic: "ssh exited before local forward listener opened",
      expectedAttempts: 4,
      expectedFailure: "listener-retry-limit",
      name: "listener failure",
    },
    {
      diagnostic: SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC,
      expectedAttempts: 13,
      expectedFailure: "readiness-retry-limit",
      name: "readiness handoff",
    },
  ] as const)(
    "keeps the $name retry limit",
    ({ diagnostic, expectedAttempts, expectedFailure }) => {
      const runForwardStart = vi.fn((stdio: "ignore" | ["ignore", number, number]) => {
        fs.writeSync((stdio as ["ignore", number, number])[1], diagnostic);
        return { status: 1 };
      });
      const sleepMs = vi.fn();

      const outcome = runBackgroundForwardStartWithReadinessRetry({
        runForwardStart,
        isListenerReachable: () => false,
        isRetryAllowed: () => true,
        sleepMs,
      });

      expect(outcome).toEqual({ status: 1, failureReason: expectedFailure });
      expect(runForwardStart).toHaveBeenCalledTimes(expectedAttempts);
      expect(sleepMs).toHaveBeenCalledTimes(expectedAttempts - 1);
    },
  );

  it("does not restart when the listener opens during the settle", () => {
    let listenerReachable = false;
    const runForwardStart = vi.fn((stdio: "ignore" | ["ignore", number, number]) => {
      fs.writeSync((stdio as ["ignore", number, number])[1], SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC);
      return { status: 1 };
    });

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => listenerReachable,
      isRetryAllowed: () => true,
      sleepMs: () => {
        listenerReachable = true;
      },
    });

    expect(outcome).toEqual({ status: 1, failureReason: "listener-reachable" });
    expect(runForwardStart).toHaveBeenCalledOnce();
  });

  it("rechecks retry permission after the settle", () => {
    const runForwardStart = vi.fn((stdio: "ignore" | ["ignore", number, number]) => {
      fs.writeSync((stdio as ["ignore", number, number])[1], SANDBOX_NOT_READY_FORWARD_DIAGNOSTIC);
      return { status: 1 };
    });
    const isRetryAllowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => false,
      isRetryAllowed,
      sleepMs: () => {},
    });

    expect(outcome).toEqual({ status: 1, failureReason: "retry-not-allowed" });
    expect(runForwardStart).toHaveBeenCalledOnce();
    expect(isRetryAllowed).toHaveBeenCalledTimes(2);
  });

  it("still starts the forward when no diagnostic file can be created", () => {
    vi.spyOn(tempFiles, "secureTempFile").mockImplementation(() => {
      throw new Error("no space left on device");
    });
    const runForwardStart = vi.fn(() => ({ status: 0 }));

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => false,
      isRetryAllowed: () => true,
      sleepMs: () => {},
    });

    expect(outcome.status).toBe(0);
    expect(outcome.failureReason).toBeUndefined();
    expect(runForwardStart).toHaveBeenCalledWith("ignore");
  });

  it("preserves a successful start when diagnostic cleanup fails", () => {
    const cleanupTempDir = tempFiles.cleanupTempDir;
    const cleanupSpy = vi
      .spyOn(tempFiles, "cleanupTempDir")
      .mockImplementation((...args: Parameters<typeof tempFiles.cleanupTempDir>) => {
        cleanupTempDir(...args);
        throw new Error("directory is busy");
      });
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runForwardStart = vi.fn(() => ({ status: 0 }));

    const outcome = runBackgroundForwardStartWithReadinessRetry({
      runForwardStart,
      isListenerReachable: () => false,
      isRetryAllowed: () => true,
      sleepMs: () => {},
    });

    expect(outcome).toEqual({ status: 0 });
    expect(cleanupSpy).toHaveBeenCalledOnce();
    const diagnosticPath = cleanupSpy.mock.calls[0]?.[0];
    expect(diagnosticPath).toBeDefined();
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.dirname(String(diagnosticPath))),
    );
  });
});
