// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processInspectionDeadlineAfter, processInspectionDeadlineReached } from "./timer-control";

describe("process inspection deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remain bounded when the wall clock moves backward", () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const deadline = processInspectionDeadlineAfter(500);

    wallClock.mockReturnValue(-50_000);
    monotonicNow.mockReturnValue(1_499);
    expect(processInspectionDeadlineReached(deadline)).toBe(false);

    monotonicNow.mockReturnValue(1_500);
    expect(processInspectionDeadlineReached(deadline)).toBe(true);
  });
});
