// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  hermesCronJobRuntimeState,
  parseHermesCronBeginReceipt,
} from "../live/rebuild-hermes-cron-restore.ts";

describe("Hermes rebuild cron restore evidence", () => {
  it("reads the flat runtime state emitted by Hermes", () => {
    expect(
      hermesCronJobRuntimeState(
        {
          last_run_at: null,
          last_status: null,
          next_run_at: "2026-08-06T19:41:01.000Z",
          repeat: { completed: 0, times: null },
          state: "scheduled",
        },
        "cron job fixture",
      ),
    ).toEqual({
      completed: 0,
      lastRunAt: null,
      lastStatus: null,
      nextRunAt: "2026-08-06T19:41:01.000Z",
      state: "scheduled",
    });
  });

  it("rejects the nested state shape that hid the live rebuild contract", () => {
    expect(() =>
      hermesCronJobRuntimeState(
        {
          state: {
            last_run_at: null,
            last_status: null,
            next_run_at: "2026-08-06T19:41:01.000Z",
            repeat: { completed: 0, times: null },
          },
        },
        "cron job fixture",
      ),
    ).toThrow("cron job fixture repeat state is not an object");
  });

  it.each([-1, 0.5])("rejects invalid completed run count %s", (completed) => {
    expect(() =>
      hermesCronJobRuntimeState(
        {
          next_run_at: "2026-08-06T19:41:01.000Z",
          repeat: { completed, times: null },
          state: "scheduled",
        },
        "cron job fixture",
      ),
    ).toThrow("cron job fixture completed run count is unavailable");
  });

  it("accepts the redacted cron drain receipt returned by shell probes", () => {
    expect(
      parseHermesCronBeginReceipt(
        'NEMOCLAW_HERMES_CRON_RESTORE_V1:{"action":"begin","active_agents":0,"disposition":"drain-acquired","drain_acquired":true,"drain_token":"<REDACTED>","operator_drain_active":false,"pid":263,"start_time":47767,"version":1}\n',
      ),
    ).toMatchObject({
      drain_token: "<REDACTED>",
      pid: 263,
      start_time: 47767,
    });
  });
});
