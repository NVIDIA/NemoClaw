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

  it.each([
    ["matching", "proc:100", "proc:100", "held", true],
    ["reused", "proc:100", "proc:101", "stale", null],
    ["rebooted", "linux:boot-a:100", "linux:boot-b:100", "stale", null],
    ["reused current PID", "proc:100", "proc:101", "stale", null],
    ["unverifiable", "proc:100", null, "held", false],
  ] as const)(
    "classifies a live PID from exact process identity evidence [%s]",
    (_case, recordedIdentity, observedIdentity, expectedState, identityVerified) => {
      const probes: ProcessIdentityProbes = {
        currentPid: 101,
        isAlive: () => true,
        readStrongIdentity: () => observedIdentity,
      };
      const contents = JSON.stringify({
        pid: _case === "reused current PID" ? probes.currentPid : 202,
        processStartIdentity: recordedIdentity,
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      });

      const disposition = classifyOnboardLockContents(contents, 99_999, 100_000, probes);
      expect(disposition).toMatchObject(
        identityVerified === null
          ? { state: expectedState }
          : { state: expectedState, identityVerified },
      );
    },
  );
});
