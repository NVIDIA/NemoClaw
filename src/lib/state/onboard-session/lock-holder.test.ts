// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ProcessIdentityProbes } from "../../adapters/process/identity";
import { classifyOnboardLockContents } from "./lock-holder";

const liveProbes: ProcessIdentityProbes = {
  currentPid: 101,
  isAlive: () => true,
  readStrongIdentity: () => null,
};

const departedProbes: ProcessIdentityProbes = {
  ...liveProbes,
  isAlive: () => false,
};

describe("onboarding lock classification", () => {
  it.each([
    ["malformed JSON", "{not-json"],
    ["zero PID", JSON.stringify({ pid: 0 })],
    ["negative PID", JSON.stringify({ pid: -1 })],
    ["fractional PID", JSON.stringify({ pid: 1.5 })],
  ])("ages a stable owner-less record from settling to stale [%s]", (_case, contents) => {
    const nowMs = 100_000;

    expect(classifyOnboardLockContents(contents, nowMs - 10_000, nowMs, liveProbes)).toEqual({
      state: "settling",
    });
    expect(classifyOnboardLockContents(contents, nowMs - 31_000, nowMs, liveProbes)).toEqual({
      state: "stale",
    });
  });

  it("classifies a live valid owner as held", () => {
    const contents = JSON.stringify({
      pid: liveProbes.currentPid,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 0, 100_000, liveProbes)).toEqual({
      state: "held",
      identityVerified: false,
      record: {
        pid: liveProbes.currentPid,
        processStartIdentity: null,
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      },
    });
  });

  it("classifies a valid record whose owner departed as stale", () => {
    expect(
      classifyOnboardLockContents(
        JSON.stringify({ pid: 424_242, startedAt: null, command: null }),
        90_000,
        100_000,
        departedProbes,
      ),
    ).toEqual({ state: "stale" });
  });

  it("holds a live PID whose strong process identity matches", () => {
    const probes: ProcessIdentityProbes = {
      currentPid: 101,
      isAlive: () => true,
      readStrongIdentity: () => "proc:100",
    };
    const contents = JSON.stringify({
      pid: 202,
      processStartIdentity: "proc:100",
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "held",
      identityVerified: true,
      record: {
        pid: 202,
        processStartIdentity: "proc:100",
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      },
    });
  });

  it.each([
    ["reused PID", 202, "proc:100", "proc:101"],
    ["rebooted host", 202, "linux:boot-a:100", "linux:boot-b:100"],
    ["reused current PID", liveProbes.currentPid, "proc:100", "proc:101"],
  ] as const)("marks a live %s generation as stale", (_case, pid, recorded, observed) => {
    const probes: ProcessIdentityProbes = {
      currentPid: liveProbes.currentPid,
      isAlive: () => true,
      readStrongIdentity: () => observed,
    };
    const contents = JSON.stringify({
      pid,
      processStartIdentity: recorded,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "stale",
    });
  });

  it("holds a live PID when strong process identity is unavailable", () => {
    const probes: ProcessIdentityProbes = {
      currentPid: 101,
      isAlive: () => true,
      readStrongIdentity: () => null,
    };
    const contents = JSON.stringify({
      pid: 202,
      processStartIdentity: "proc:100",
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "held",
      identityVerified: false,
      record: {
        pid: 202,
        processStartIdentity: "proc:100",
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      },
    });
  });
});
