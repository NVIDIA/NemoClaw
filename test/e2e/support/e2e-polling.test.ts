// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { PollingError, pollUntil } from "../fixtures/polling.ts";

describe("bounded polling", () => {
  it("numbers artifacts and returns the accepted attempt", async () => {
    const probe = vi.fn(async (attempt: number) => attempt);
    const result = await pollUntil({
      artifactPrefix: "ready",
      attempts: 3,
      probe,
      accept: (v) => v === 2,
    });
    expect(result).toEqual({ attempt: 2, artifactName: "ready-attempt-02", value: 2 });
  });

  it("supports backoff and exposes the last result on exhaustion", async () => {
    const delays: number[] = [];
    let error: PollingError<string> | undefined;
    try {
      await pollUntil({
        artifactPrefix: "health",
        attempts: 2,
        delayMs: (attempt) => attempt * 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
        probe: async (attempt) => `not-ready-${attempt}`,
        accept: () => false,
      });
    } catch (caught) {
      expect(caught).toBeInstanceOf(PollingError);
      error = caught as PollingError<string>;
    }
    expect(delays).toEqual([10, 20]);
    expect(error?.lastAttempt?.value).toBe("not-ready-2");
    expect(error?.reason).toBe("exhausted");
  });

  it("honors deadlines, terminal states, and abort signals", async () => {
    let now = 0;
    await expect(
      pollUntil({
        artifactPrefix: "deadline",
        deadlineMs: 5,
        now: () => now,
        probe: async () => {
          now = 5;
          return "pending";
        },
        accept: () => false,
      }),
    ).rejects.toThrow(/exhausted/);
    await expect(
      pollUntil({
        artifactPrefix: "terminal",
        attempts: 3,
        probe: async () => "Failed",
        accept: () => false,
        terminal: (value) => (value === "Failed" ? "terminal failure" : undefined),
      }),
    ).rejects.toMatchObject({ reason: "terminal" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollUntil({
        artifactPrefix: "abort",
        attempts: 1,
        signal: controller.signal,
        probe: async () => true,
        accept: Boolean,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });
});
