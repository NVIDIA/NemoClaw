// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cronJobState } from "../live/rebuild-hermes-cron-restore.ts";

describe("Hermes rebuild cron state compatibility", () => {
  it("reads the historical nested cron state (#7806)", () => {
    const state = {
      last_run_at: null,
      next_run_at: "2026-08-06T16:48:44.080564+00:00",
      repeat: { completed: 0 },
    };

    expect(cronJobState({ id: "job-1", state }, "cron job job-1")).toBe(state);
  });

  it("reads flattened cron state from the current Hermes runtime (#7806)", () => {
    const job = {
      id: "job-1",
      last_run_at: null,
      next_run_at: "2026-08-06T16:48:44.080564+00:00",
      repeat: { completed: 0 },
      state: "scheduled",
    };

    expect(cronJobState(job, "cron job job-1")).toBe(job);
  });

  it("rejects cron state without either supported shape (#7806)", () => {
    expect(() => cronJobState({ id: "job-1", state: null }, "cron job job-1")).toThrow(
      "cron job job-1 state is not an object",
    );
  });
});
