// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { relockAndReconfirm, resolveSettleMs } from "./relock-reconfirm";

const sealedHashes = {
  "/sandbox/.openclaw/openclaw.json":
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "/sandbox/.openclaw/.config-hash":
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
};

function okResult() {
  return { chattrApplied: true, fileHashes: sealedHashes };
}

describe("relockAndReconfirm", () => {
  it("returns ok with the re-confirmed result when the lock always succeeds", () => {
    const lock = vi.fn(() => okResult());
    const sleep = vi.fn();

    const result = relockAndReconfirm(lock, { sleep, settleMs: 5 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastResult).toEqual(okResult());
    // One apply + one re-confirm.
    expect(lock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("fails closed (bounded) when the re-confirm always throws after a clean apply", () => {
    // Apply succeeds every time, but the reconciler reverts before each
    // re-confirm so every re-confirm throws.
    const lock = vi
      .fn()
      .mockImplementationOnce(() => okResult()) // attempt 1 apply
      .mockImplementationOnce(() => {
        throw new Error("drift");
      }) // attempt 1 re-confirm
      .mockImplementationOnce(() => okResult()) // attempt 2 apply
      .mockImplementationOnce(() => {
        throw new Error("drift");
      }) // attempt 2 re-confirm
      .mockImplementationOnce(() => okResult()) // attempt 3 apply
      .mockImplementationOnce(() => {
        throw new Error("drift");
      }); // attempt 3 re-confirm
    const sleep = vi.fn();

    const result = relockAndReconfirm(lock, { sleep, settleMs: 0, maxAttempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.lastResult).toBeNull();
    expect(result.error).toBe("drift");
    // Bounded: 2 calls per attempt × 3 attempts.
    expect(lock).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("retries the whole cycle when the lock reverts once then holds", () => {
    const lock = vi
      .fn()
      .mockImplementationOnce(() => okResult()) // attempt 1 apply
      .mockImplementationOnce(() => {
        throw new Error("reverted during settle");
      }) // attempt 1 re-confirm — reverted
      .mockImplementationOnce(() => okResult()) // attempt 2 apply
      .mockImplementationOnce(() => okResult()); // attempt 2 re-confirm — holds
    const sleep = vi.fn();

    const result = relockAndReconfirm(lock, { sleep, settleMs: 0, maxAttempts: 3 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.lastResult).toEqual(okResult());
    expect(lock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on attempt 1 when the first apply throws, never sleeping", () => {
    const lock = vi.fn(() => {
      throw new Error("cannot apply lock");
    });
    const sleep = vi.fn();

    const result = relockAndReconfirm(lock, { sleep, settleMs: 0, maxAttempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastResult).toBeNull();
    expect(result.error).toBe("cannot apply lock");
    expect(lock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("resolveSettleMs", () => {
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSettle = process.env.NEMOCLAW_SHIELDS_SETTLE_MS;

  afterEach(() => {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSettle === undefined) delete process.env.NEMOCLAW_SHIELDS_SETTLE_MS;
    else process.env.NEMOCLAW_SHIELDS_SETTLE_MS = originalSettle;
  });

  it("returns 0 under test (VITEST=true) so suites do not block", () => {
    process.env.VITEST = "true";
    expect(resolveSettleMs()).toBe(0);
  });

  it("applies the real settle window when only NODE_ENV=test (VITEST is the sole test signal)", () => {
    // Security: NODE_ENV=test must NOT collapse the durability wait to 0. Only
    // Vitest (VITEST=true) is treated as a test runtime; a production
    // deployment that happens to run with NODE_ENV=test keeps the real settle.
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
    delete process.env.NEMOCLAW_SHIELDS_SETTLE_MS;
    expect(resolveSettleMs()).toBe(750);
  });

  it("defaults to 750ms outside test when env is unset", () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    delete process.env.NEMOCLAW_SHIELDS_SETTLE_MS;
    expect(resolveSettleMs()).toBe(750);
  });

  it("clamps an over-range env value to the upper bound", () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    process.env.NEMOCLAW_SHIELDS_SETTLE_MS = "999999";
    expect(resolveSettleMs()).toBe(10_000);
  });

  it("clamps a negative env value to 0", () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    process.env.NEMOCLAW_SHIELDS_SETTLE_MS = "-500";
    expect(resolveSettleMs()).toBe(0);
  });

  it("honours a valid in-range env value", () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    process.env.NEMOCLAW_SHIELDS_SETTLE_MS = "1500";
    expect(resolveSettleMs()).toBe(1500);
  });
});
