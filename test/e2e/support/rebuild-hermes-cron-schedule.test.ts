// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildHermesRecoveryCronSchedule } from "../live/rebuild-hermes-cron-schedule.ts";

describe("Hermes rebuild cron recovery schedule", () => {
  it("makes the recovery job due during the stranded-gate probe", () => {
    const nowMs = Date.UTC(2026, 7, 5, 17, 27, 59);

    expect(buildHermesRecoveryCronSchedule(nowMs)).toEqual({
      runAt: "2026-08-05T17:28:09.000Z",
      runAtMs: nowMs + 10_000,
    });
  });
});
