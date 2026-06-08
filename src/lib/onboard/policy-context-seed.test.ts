// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { seedInitialPolicyContext } from "./policy-context-seed";

describe("seedInitialPolicyContext", () => {
  it("calls the injected refresh function with the sandbox name", () => {
    const refresh = vi.fn(() => ({ outcome: "ok" }));
    const logError = vi.fn();

    seedInitialPolicyContext("alpha", { refresh, logError });

    expect(refresh).toHaveBeenCalledWith("alpha");
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs once on stderr when the refresh function throws", () => {
    const refresh = vi.fn(() => {
      throw new Error("require failed: cannot find module");
    });
    const logError = vi.fn();

    seedInitialPolicyContext("alpha", { refresh, logError });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toContain("[onboard]");
    expect(logError.mock.calls[0][0]).toContain("require failed");
  });

  it("stringifies non-Error throws so the log never silently drops the cause", () => {
    const refresh = vi.fn(() => {
      // eslint-disable-next-line no-throw-literal
      throw "broken-string";
    });
    const logError = vi.fn();

    seedInitialPolicyContext("alpha", { refresh, logError });

    expect(logError.mock.calls[0][0]).toContain("broken-string");
  });

  it("does not rethrow — the onboard run continues even when the refresh helper crashes", () => {
    const refresh = vi.fn(() => {
      throw new Error("crash");
    });
    const logError = vi.fn();

    expect(() => seedInitialPolicyContext("alpha", { refresh, logError })).not.toThrow();
  });
});
