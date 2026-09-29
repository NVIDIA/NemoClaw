// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { seedInitialPolicyContext } from "./policy-context-seed";

describe("seedInitialPolicyContext", () => {
  it("calls the injected refresh function with the sandbox name", async () => {
    const refresh = vi.fn(() => ({ outcome: "ok" }));
    const logError = vi.fn();

    await seedInitialPolicyContext("alpha", { refresh, logError });

    expect(refresh).toHaveBeenCalledWith("alpha");
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs once on stderr when the refresh function throws", async () => {
    const refresh = vi.fn(() => {
      throw new Error("require failed: cannot find module");
    });
    const logError = vi.fn();

    await seedInitialPolicyContext("alpha", { refresh, logError });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toContain("[onboard]");
    expect(logError.mock.calls[0][0]).toContain("require failed");
  });

  it("stringifies non-Error throws so the log never silently drops the cause", async () => {
    const refresh = vi.fn(() => {
      throw "broken-string";
    });
    const logError = vi.fn();

    await seedInitialPolicyContext("alpha", { refresh, logError });

    expect(logError.mock.calls[0][0]).toContain("broken-string");
  });

  it("does not rethrow: the onboard run continues even when the refresh helper crashes", async () => {
    const refresh = vi.fn(() => {
      throw new Error("crash");
    });
    const logError = vi.fn();

    await expect(seedInitialPolicyContext("alpha", { refresh, logError })).resolves.toBeUndefined();
  });

  it("waits for deferred refresh failures without changing process.exit", async () => {
    const original = process.exit;
    const logError = vi.fn();
    let rejectRefresh!: (error: Error) => void;
    const pending = seedInitialPolicyContext("alpha", {
      refresh: () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
      logError,
    });
    expect(process.exit).toBe(original);
    rejectRefresh(new Error("deferred refresh failed"));
    await pending;
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      "  [onboard] Could not seed sandbox policy context: deferred refresh failed",
    );
    expect(process.exit).toBe(original);
  });
});
