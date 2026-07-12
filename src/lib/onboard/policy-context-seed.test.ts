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

  it("isolates process.exit calls inside refresh from the surrounding caller", () => {
    // The refresh path can call `process.exit(1)` via the openshell spawn
    // helpers. When the caller is rebuild.ts (which itself overrides
    // process.exit to flag onboard failure), an unisolated exit corrupts
    // the rebuild's recovery flag even though the seed is meant to be
    // best-effort. The seed must shadow `process.exit` so any exit attempt
    // the refresh path makes becomes a swallowed error.
    const exitCalls: Array<number | undefined> = [];
    const installerExit = ((code?: number) => {
      exitCalls.push(code);
      throw new Error(`installer exit ${String(code)}`);
    }) as typeof process.exit;
    const original = process.exit;
    process.exit = installerExit;

    const refresh = vi.fn(() => {
      // Mimic the openshell spawn-error path that calls process.exit(1).
      process.exit(1);
    });
    const logError = vi.fn();

    try {
      seedInitialPolicyContext("alpha", { refresh, logError });
    } finally {
      process.exit = original;
    }

    // The installer-level process.exit must not have fired — the seed's
    // own shadow replaced it for the duration of the refresh.
    expect(exitCalls).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toContain("process.exit(1)");
  });

  it("restores process.exit after the refresh returns, regardless of throw or success", () => {
    const original = process.exit;
    const refresh = vi.fn(() => undefined);

    seedInitialPolicyContext("alpha", { refresh, logError: vi.fn() });
    expect(process.exit).toBe(original);

    const refreshThrows = vi.fn(() => {
      throw new Error("boom");
    });
    seedInitialPolicyContext("alpha", { refresh: refreshThrows, logError: vi.fn() });
    expect(process.exit).toBe(original);
  });
});
