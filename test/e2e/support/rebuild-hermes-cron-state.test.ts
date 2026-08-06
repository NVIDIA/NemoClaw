// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { hermesCronRuntimeFields } from "../live/rebuild-hermes-cron-state.ts";

describe("Hermes rebuild cron state", () => {
  it("reads runtime fields from a historical flat cron job", () => {
    const job = {
      state: "scheduled",
      repeat: { completed: 0 },
      next_run_at: "2026-08-06T15:39:18.552123+00:00",
      last_run_at: null,
      last_status: null,
    };

    expect(hermesCronRuntimeFields(job, "historical cron job")).toBe(job);
  });

  it.each([null, [], {}, 1, true, undefined])("rejects an unsupported cron state: %s", (state) => {
    expect(() => hermesCronRuntimeFields({ state }, "invalid cron job")).toThrow(
      "invalid cron job state is not a status string",
    );
  });
});
