// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  withTimerBoundShieldsMutationLock,
  withTimerBoundShieldsMutationLockAsync,
  withTimerBoundShieldsMutationLockFallback,
} from "./timer-bound-lock";

describe("timer-bound shields mutation lock", () => {
  it("retries without mutating when the timer generation changes while waiting", () => {
    const oldToken = "1".repeat(32);
    const newToken = "2".repeat(32);
    const tokens = [oldToken, newToken, newToken, newToken];
    const callback = vi.fn(() => "done");
    const observedOptions: unknown[] = [];

    const result = withTimerBoundShieldsMutationLock("alpha", "config set write", callback, {
      readToken: () => tokens.shift(),
      withLock: (_name, _command, fn, options) => {
        observedOptions.push(options);
        return fn();
      },
      withLockAsync: vi.fn(),
    });

    expect(result).toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(observedOptions).toEqual([{ takeoverToken: oldToken }, { takeoverToken: newToken }]);
  });

  it("binds the async operation to the stable current timer token", async () => {
    const token = "a".repeat(32);
    const callback = vi.fn(async () => 42);
    const withLockAsync = vi.fn(async (_name, _command, fn, options) => {
      expect(options).toEqual({ takeoverToken: token });
      return fn();
    });

    await expect(
      withTimerBoundShieldsMutationLockAsync("alpha", "inference set", callback, {
        readToken: () => token,
        withLock: vi.fn(),
        withLockAsync,
      }),
    ).resolves.toBe(42);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("uses the fallback token when no timer marker exists", () => {
    const fallbackToken = "b".repeat(32);
    const callback = vi.fn(() => "done");
    const withLock = vi.fn((_name, _command, fn, options) => {
      expect(options).toEqual({ takeoverToken: fallbackToken });
      return fn();
    });

    expect(
      withTimerBoundShieldsMutationLockFallback("alpha", "shields down", fallbackToken, callback, {
        readToken: () => undefined,
        withLock,
        withLockAsync: vi.fn(),
      }),
    ).toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("gives an existing timer marker token priority over the fallback", () => {
    const fallbackToken = "b".repeat(32);
    const markerToken = "c".repeat(32);
    const callback = vi.fn(() => "done");
    const withLock = vi.fn((_name, _command, fn, options) => {
      expect(options).toEqual({ takeoverToken: markerToken });
      return fn();
    });

    expect(
      withTimerBoundShieldsMutationLockFallback("alpha", "shields down", fallbackToken, callback, {
        readToken: () => markerToken,
        withLock,
        withLockAsync: vi.fn(),
      }),
    ).toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("retries a marker generation change and preserves marker priority", () => {
    const fallbackToken = "b".repeat(32);
    const markerToken = "c".repeat(32);
    const tokens = [undefined, markerToken, markerToken, markerToken];
    const callback = vi.fn(() => "done");
    const observedOptions: unknown[] = [];

    expect(
      withTimerBoundShieldsMutationLockFallback("alpha", "shields down", fallbackToken, callback, {
        readToken: () => tokens.shift(),
        withLock: (_name, _command, fn, options) => {
          observedOptions.push(options);
          return fn();
        },
        withLockAsync: vi.fn(),
      }),
    ).toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(observedOptions).toEqual([
      { takeoverToken: fallbackToken },
      { takeoverToken: markerToken },
    ]);
  });

  it("fails closed when timer generations keep changing", () => {
    let generation = 0;
    expect(() =>
      withTimerBoundShieldsMutationLock("alpha", "gateway restart", () => undefined, {
        readToken: () => (++generation).toString(16).padStart(32, "0"),
        withLock: (_name, _command, fn) => fn(),
        withLockAsync: vi.fn(),
      }),
    ).toThrow(/kept changing/);
  });
});
