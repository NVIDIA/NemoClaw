// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  classifyOnboardLockContents,
  createOnboardLockRecord,
  type OnboardLockIdentityProbes,
} from "./lock-holder";

const liveProbes: OnboardLockIdentityProbes = {
  currentPid: 101,
  localHostIdentity: "host:test",
  localPidNamespaceIdentity: "pid:[100]",
  isAlive: () => true,
  readStrongIdentity: () => null,
};

const departedProbes: OnboardLockIdentityProbes = {
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
      hostIdentity: liveProbes.localHostIdentity,
      pidNamespaceIdentity: liveProbes.localPidNamespaceIdentity,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 0, 100_000, liveProbes)).toEqual({
      state: "held",
      identityVerified: false,
      provenance: "local",
      record: {
        pid: liveProbes.currentPid,
        processStartIdentity: null,
        hostIdentity: liveProbes.localHostIdentity,
        pidNamespaceIdentity: liveProbes.localPidNamespaceIdentity,
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      },
    });
  });

  it("classifies a valid record whose owner departed as stale", () => {
    expect(
      classifyOnboardLockContents(
        JSON.stringify({
          pid: 424_242,
          hostIdentity: departedProbes.localHostIdentity,
          pidNamespaceIdentity: departedProbes.localPidNamespaceIdentity,
          startedAt: null,
          command: null,
        }),
        90_000,
        100_000,
        departedProbes,
      ),
    ).toEqual({ state: "stale" });
  });

  it("holds a live PID whose strong process identity matches", () => {
    const probes: OnboardLockIdentityProbes = {
      currentPid: 101,
      localHostIdentity: "host:test",
      localPidNamespaceIdentity: "pid:[100]",
      isAlive: () => true,
      readStrongIdentity: () => "proc:100",
    };
    const contents = JSON.stringify({
      pid: 202,
      processStartIdentity: "proc:100",
      hostIdentity: probes.localHostIdentity,
      pidNamespaceIdentity: probes.localPidNamespaceIdentity,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "held",
      identityVerified: true,
      provenance: "local",
      record: {
        pid: 202,
        processStartIdentity: "proc:100",
        hostIdentity: probes.localHostIdentity,
        pidNamespaceIdentity: probes.localPidNamespaceIdentity,
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
    const probes: OnboardLockIdentityProbes = {
      currentPid: liveProbes.currentPid,
      localHostIdentity: "host:test",
      localPidNamespaceIdentity: "pid:[100]",
      isAlive: () => true,
      readStrongIdentity: () => observed,
    };
    const contents = JSON.stringify({
      pid,
      processStartIdentity: recorded,
      hostIdentity: probes.localHostIdentity,
      pidNamespaceIdentity: probes.localPidNamespaceIdentity,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "stale",
    });
  });

  it("holds a live PID when strong process identity is unavailable", () => {
    const probes: OnboardLockIdentityProbes = {
      currentPid: 101,
      localHostIdentity: "host:test",
      localPidNamespaceIdentity: "pid:[100]",
      isAlive: () => true,
      readStrongIdentity: () => null,
    };
    const contents = JSON.stringify({
      pid: 202,
      processStartIdentity: "proc:100",
      hostIdentity: probes.localHostIdentity,
      pidNamespaceIdentity: probes.localPidNamespaceIdentity,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toEqual({
      state: "held",
      identityVerified: false,
      provenance: "local",
      record: {
        pid: 202,
        processStartIdentity: "proc:100",
        hostIdentity: probes.localHostIdentity,
        pidNamespaceIdentity: probes.localPidNamespaceIdentity,
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "nemoclaw onboard",
      },
    });
  });

  it("holds a same-hostname owner when stable host identity is unavailable", () => {
    const isAlive = vi.fn(() => true);
    const readStrongIdentity = vi.fn(() => "linux:boot-b:100");
    const probes: OnboardLockIdentityProbes = {
      currentPid: 101,
      localHostIdentity: null,
      localPidNamespaceIdentity: "pid:[100]",
      isAlive,
      readStrongIdentity,
    };
    const contents = JSON.stringify({
      pid: 202,
      processStartIdentity: "linux:boot-a:100",
      hostIdentity: null,
      pidNamespaceIdentity: probes.localPidNamespaceIdentity,
      startedAt: "2026-09-01T00:00:00.000Z",
      command: "nemoclaw onboard",
    });

    expect(classifyOnboardLockContents(contents, 99_999, 100_000, probes)).toMatchObject({
      state: "held",
      identityVerified: false,
      provenance: "unknown",
      record: { pid: 202 },
    });
    expect(isAlive).not.toHaveBeenCalled();
    expect(readStrongIdentity).not.toHaveBeenCalled();
  });

  it.each([
    [
      "foreign host",
      {
        pid: 202,
        hostIdentity: "host:foreign",
        pidNamespaceIdentity: liveProbes.localPidNamespaceIdentity,
      },
      "foreign",
    ],
    [
      "foreign PID namespace",
      {
        pid: 202,
        hostIdentity: liveProbes.localHostIdentity,
        pidNamespaceIdentity: "pid:[200]",
      },
      "foreign",
    ],
    ["legacy owner without provenance", { pid: 202 }, "unknown"],
  ] as const)("holds a %s without consulting the local PID table", (_case, owner, provenance) => {
    const isAlive = vi.fn(() => false);
    const probes = { ...liveProbes, isAlive };

    expect(classifyOnboardLockContents(JSON.stringify(owner), 0, 100_000, probes)).toMatchObject({
      state: "held",
      identityVerified: false,
      provenance,
      record: { pid: 202 },
    });
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("persists host and PID-namespace provenance in new owner records", () => {
    expect(
      createOnboardLockRecord("nemoclaw onboard", "2026-09-02T00:00:00.000Z", liveProbes),
    ).toMatchObject({
      pid: liveProbes.currentPid,
      hostIdentity: liveProbes.localHostIdentity,
      pidNamespaceIdentity: liveProbes.localPidNamespaceIdentity,
    });
  });
});
