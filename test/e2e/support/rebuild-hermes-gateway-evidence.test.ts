// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseHermesGatewayEvidence } from "../live/rebuild-hermes-cron-restore.ts";

const liveEvidence = {
  active_agents: 0,
  gateway_state: "draining",
  pid: 263,
  running_pid: 263,
  start_time: 28_765,
};

describe("Hermes rebuild gateway evidence", () => {
  it("accepts a live gateway identity", () => {
    expect(parseHermesGatewayEvidence(JSON.stringify(liveEvidence))).toEqual(liveEvidence);
  });

  it("accepts stale status while the restarted gateway process is unavailable", () => {
    const transient = { ...liveEvidence, running_pid: null };

    expect(parseHermesGatewayEvidence(JSON.stringify(transient))).toEqual(transient);
  });

  it.each([
    ["missing", undefined],
    ["string", "263"],
    ["fractional", 263.5],
  ])("rejects a %s running process identity", (_label, runningPid) => {
    expect(() =>
      parseHermesGatewayEvidence(JSON.stringify({ ...liveEvidence, running_pid: runningPid })),
    ).toThrow("Hermes gateway running_pid is invalid");
  });

  it.each([
    "active_agents",
    "pid",
    "start_time",
  ] as const)("keeps %s strict while accepting the restart transient", (field) => {
    expect(() =>
      parseHermesGatewayEvidence(JSON.stringify({ ...liveEvidence, [field]: null })),
    ).toThrow(`Hermes gateway ${field} is invalid`);
  });

  it("rejects an invalid gateway state", () => {
    expect(() =>
      parseHermesGatewayEvidence(JSON.stringify({ ...liveEvidence, gateway_state: null })),
    ).toThrow("Hermes gateway state is invalid");
  });
});
