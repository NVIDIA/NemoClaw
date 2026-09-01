// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  deferSandboxLifecycleExit,
  normalizeProcessExitCode,
  runWithDeferredSandboxLifecycleExit,
  spawnExitCode,
} from "./process-exit";

describe("normalizeProcessExitCode", () => {
  it.each([
    ["absent value", undefined, 0, 0],
    ["null value", null, 0, 0],
    ["custom absent fallback", undefined, 1, 1],
    ["numeric value", 7, 0, 7],
    ["integer-string value", "7", 0, 7],
    ["whitespace zero", "  ", 1, 0],
    ["empty string", "", 0, 1],
    ["fractional string", "7.5", 0, 1],
    ["nonnumeric string", "bad", 0, 1],
  ] satisfies Array<[string, number | string | null | undefined, number, number]>)(
    "normalizes %s",
    (_label, value, absentExitCode, expected) => {
      expect(normalizeProcessExitCode(value, absentExitCode)).toBe(expected);
    },
  );
});

describe("runWithDeferredSandboxLifecycleExit", () => {
  it("returns a completed operation without exiting", async () => {
    const exit = vi.fn((_exitCode: number): never => {
      throw new Error("unexpected exit");
    });

    await expect(
      runWithDeferredSandboxLifecycleExit(async () => "complete", exit),
    ).resolves.toBe("complete");
    expect(exit).not.toHaveBeenCalled();
  });

  it("propagates an ordinary operation failure without exiting", async () => {
    const exit = vi.fn((_exitCode: number): never => {
      throw new Error("unexpected exit");
    });

    await expect(
      runWithDeferredSandboxLifecycleExit(async () => {
        throw new Error("operation failed");
      }, exit),
    ).rejects.toThrow("operation failed");
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits only after async cleanup completes", async () => {
    const events: string[] = [];
    const exit = vi.fn((exitCode: number): never => {
      events.push(`exit:${String(exitCode)}`);
      throw new Error(`process.exit:${String(exitCode)}`);
    });

    await expect(
      runWithDeferredSandboxLifecycleExit(async () => {
        events.push("operation");
        try {
          deferSandboxLifecycleExit(7);
        } finally {
          await Promise.resolve();
          events.push("cleanup");
        }
      }, exit),
    ).rejects.toThrow("process.exit:7");

    expect(events).toEqual(["operation", "cleanup", "exit:7"]);
    expect(exit).toHaveBeenCalledWith(7);
  });
});

describe("spawnExitCode", () => {
  it.each([
    ["zero status", { status: 0 }, 0],
    ["nonzero status", { status: 42 }, 42],
    ["status before signal", { status: 7, signal: "SIGTERM" }, 7],
    ["SIGINT", { status: null, signal: "SIGINT" }, 130],
    ["SIGTERM", { status: null, signal: "SIGTERM" }, 143],
    ["SIGKILL", { status: null, signal: "SIGKILL" }, 137],
    ["missing signal", { status: null }, 1],
    ["null signal", { status: null, signal: null }, 1],
    ["unknown signal", { status: null, signal: "SIGBOGUS" as NodeJS.Signals }, 1],
  ] satisfies Array<[string, Parameters<typeof spawnExitCode>[0], number]>)(
    "normalizes %s (#5936)",
    (_label, result, expected) => {
      expect(spawnExitCode(result)).toBe(expected);
    },
  );
});
