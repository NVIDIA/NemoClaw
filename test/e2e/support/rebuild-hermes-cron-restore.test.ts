// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  cronJobState,
  parseCronTickerTimestamp,
  parseHermesCronBeginReceipt,
} from "../live/rebuild-hermes-cron-restore.ts";

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

describe("Hermes rebuild cron begin receipt", () => {
  const receipt = {
    action: "begin",
    active_agents: 0,
    disposition: "drain-acquired",
    drain_acquired: true,
    drain_token: "<REDACTED>",
    operator_drain_active: false,
    pid: 263,
    start_time: 29_607,
    version: 1,
  };

  it("accepts the canonically redacted ShellProbe receipt", () => {
    expect(
      parseHermesCronBeginReceipt(`NEMOCLAW_HERMES_CRON_RESTORE_V1:${JSON.stringify(receipt)}\n`),
    ).toMatchObject({ pid: 263, start_time: 29_607 });
  });

  it("rejects an unredacted drain token crossing the ShellProbe boundary", () => {
    expect(() =>
      parseHermesCronBeginReceipt(
        `NEMOCLAW_HERMES_CRON_RESTORE_V1:${JSON.stringify({
          ...receipt,
          drain_token: "a".repeat(32),
        })}\n`,
      ),
    ).toThrow("Hermes cron begin receipt identity is invalid");
  });
});

describe("Hermes rebuild cron ticker timestamp", () => {
  it("accepts the initial missing-file sentinel", () => {
    expect(parseCronTickerTimestamp("0\n", "ticker timestamp")).toBe(0);
  });

  it("parses the ticker epoch", () => {
    expect(parseCronTickerTimestamp("1785951799.098\n", "ticker timestamp")).toBe(
      1_785_951_799.098,
    );
  });

  it.each([
    "",
    "not-an-epoch\n",
    "Infinity\n",
    "-1\n",
  ])("rejects malformed ticker evidence %j", (evidence) => {
    expect(() => parseCronTickerTimestamp(evidence, "ticker timestamp")).toThrow(
      "ticker timestamp is invalid",
    );
  });
});
