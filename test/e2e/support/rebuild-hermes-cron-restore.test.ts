// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  hermesCronJobRuntimeState,
  parseCronTickerTimestamp,
  parseGatewayEvidence,
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
    ).toMatchObject({ drain_token: "<REDACTED>", pid: 263, start_time: 29_607 });
  });

  it("rejects an unredacted drain token crossing the ShellProbe boundary", () => {
    expect(() =>
      parseHermesCronBeginReceipt(
        `NEMOCLAW_HERMES_CRON_RESTORE_V1:${JSON.stringify({
          ...receipt,
          drain_token: "a".repeat(32),
        })}\n`,
      ),
    ).toThrow();
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

describe("Hermes rebuild gateway evidence", () => {
  it("accepts a transient missing running process during restart", () => {
    expect(
      parseGatewayEvidence(
        JSON.stringify({
          active_agents: 0,
          gateway_state: "draining",
          pid: 263,
          running_pid: null,
          start_time: 29_607,
        }),
      ),
    ).toMatchObject({ pid: 263, running_pid: null });
  });

  it("rejects malformed running process evidence", () => {
    expect(() =>
      parseGatewayEvidence(
        JSON.stringify({
          active_agents: 0,
          gateway_state: "draining",
          pid: 263,
          running_pid: "263",
          start_time: 29_607,
        }),
      ),
    ).toThrow("Hermes gateway running_pid is invalid");
  });
});
