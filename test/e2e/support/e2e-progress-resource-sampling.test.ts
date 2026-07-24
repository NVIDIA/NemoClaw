// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { startTestProgress, type TestProgressOptions } from "../fixtures/progress.ts";

interface ScheduledTimer {
  atMs: number;
  callback: () => void;
}

function fail(message: string): never {
  throw new Error(message);
}

function progressHarness(
  record: NonNullable<TestProgressOptions["recordResourceSample"]>,
  clearFailures = 0,
) {
  let clockMs = 0;
  let nextTimerId = 1;
  let remainingClearFailures = clearFailures;
  let maximumActiveTimers = 0;
  const timers = new Map<number, ScheduledTimer>();
  const baselines: string[] = [];
  const legacySamples: string[] = [];
  const lines: string[] = [];
  const order: string[] = [];

  const options: TestProgressOptions = {
    now: () => clockMs,
    setTimer: (callback, delayMs) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { atMs: clockMs + delayMs, callback });
      maximumActiveTimers = Math.max(maximumActiveTimers, timers.size);
      return { id, unref() {} };
    },
    clearTimer: (handle) => {
      const shouldFail = remainingClearFailures > 0;
      remainingClearFailures = Math.max(0, remainingClearFailures - 1);
      return shouldFail
        ? fail("synthetic clear failure")
        : void timers.delete((handle as { id: number }).id);
    },
    logLine: (line) => {
      lines.push(line);
      order.push(`log:${line}`);
    },
    recordResourceBaseline: (phase) => {
      baselines.push(phase);
      order.push(`baseline:${phase}`);
    },
    recordResourceSample: (phase, kind) => {
      order.push(`sample:${kind}:${phase}`);
      return record(phase, kind);
    },
    sampleResourceEvidence: (phase) => {
      legacySamples.push(phase);
      return `E2E_RESOURCE_SNAPSHOT {"phase":"${phase}"}`;
    },
    sampleResources: () => ({
      availableMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 512 * 1024 ** 2,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    }),
  };

  const nextTimer = (): [number, ScheduledTimer] => {
    const selected = [...timers.entries()].sort((left, right) => left[1].atMs - right[1].atMs)[0];
    return selected ?? fail("no timer is scheduled");
  };

  return {
    options,
    state: {
      baselines,
      legacySamples,
      lines,
      order,
      activeTimers: () => timers.size,
      maximumActiveTimers: () => maximumActiveTimers,
      now: () => clockMs,
      nextTimerAt: () => nextTimer()[1].atMs,
      setClock: (value: number) => {
        clockMs = value;
      },
      fireNext: () => {
        const [id, timer] = nextTimer();
        timers.delete(id);
        clockMs = Math.max(clockMs, timer.atMs);
        timer.callback();
      },
    },
  };
}

describe("canonical runner comparison progress sampling", () => {
  it("uses one timer, fixed cadence, completed-phase boundaries, and a final phase sample (#7146)", () => {
    const records: Array<{ atMs: number; kind: string; phase: string }> = [];
    let state: ReturnType<typeof progressHarness>["state"];
    const harness = progressHarness((phase, kind) => {
      records.push({ atMs: state.now(), kind, phase });
      return true;
    });
    state = harness.state;
    const progress = startTestProgress(
      "runner comparison",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    expect(records).toEqual([{ atMs: 0, kind: "scenario-start", phase: "build Hermes image" }]);
    expect(state.baselines).toEqual(["build Hermes image"]);
    expect(state.order.slice(0, 3)).toEqual([
      "baseline:build Hermes image",
      expect.stringContaining("log:[e2e"),
      "sample:scenario-start:build Hermes image",
    ]);
    expect(state.activeTimers()).toBe(1);
    expect(state.nextTimerAt()).toBe(60_000);

    state.setClock(30_000);
    progress.phase("validate Hermes sandbox");
    expect(records.at(-1)).toEqual({
      atMs: 30_000,
      kind: "phase",
      phase: "build Hermes image",
    });
    expect(state.nextTimerAt()).toBe(60_000);

    state.fireNext();
    expect(records.at(-1)).toEqual({
      atMs: 60_000,
      kind: "periodic",
      phase: "validate Hermes sandbox",
    });
    expect(state.nextTimerAt()).toBe(120_000);
    state.fireNext();
    expect(records.at(-1)).toEqual({
      atMs: 120_000,
      kind: "periodic",
      phase: "validate Hermes sandbox",
    });

    state.setClock(125_000);
    progress.stop();
    expect(records.at(-1)).toEqual({
      atMs: 125_000,
      kind: "phase",
      phase: "validate Hermes sandbox",
    });
    expect(state.activeTimers()).toBe(0);
    expect(state.maximumActiveTimers()).toBe(1);
    expect(state.legacySamples).toEqual([]);
  });

  it("takes one canonical periodic sample and no legacy full sample at the five-minute collision (#7146)", () => {
    const records: string[] = [];
    const harness = progressHarness((phase, kind) => {
      records.push(`${kind}:${phase}`);
      return true;
    });
    const progress = startTestProgress(
      "runner comparison collision",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    for (let index = 0; index < 5; index += 1) harness.state.fireNext();

    expect(records.filter((entry) => entry.startsWith("periodic:"))).toHaveLength(5);
    expect(harness.state.now()).toBe(300_000);
    expect(harness.state.legacySamples).toEqual([]);
    expect(harness.state.lines).toEqual(
      expect.arrayContaining([expect.stringContaining("still running: build Hermes image")]),
    );
    expect(harness.state.maximumActiveTimers()).toBe(1);
    progress.stop();
  });

  it("suppresses legacy full evidence at a stall between periodic deadlines (#7146)", () => {
    let periodicCalls = 0;
    const harness = progressHarness((_phase, kind) => {
      periodicCalls += Number(kind === "periodic");
      return true;
    });
    harness.options.stallThresholdMs = 310_000;
    const progress = startTestProgress(
      "runner comparison unaligned stall",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    for (let index = 0; index < 6; index += 1) harness.state.fireNext();
    expect(harness.state.now()).toBe(310_000);
    expect(periodicCalls).toBe(5);
    expect(harness.state.legacySamples).toEqual([]);
    expect(harness.state.lines).toEqual(
      expect.arrayContaining([expect.stringContaining("still running: build Hermes image")]),
    );
    progress.stop();
  });

  it.each([
    "false",
    "throw",
  ] as const)("permanently falls back to legacy evidence when the collision append returns %s (#7146)", (failure) => {
    let periodicCalls = 0;
    const failAtCollision = {
      false: () => false,
      throw: () => fail("ledger unavailable"),
    } as const;
    const harness = progressHarness((_phase, kind) => {
      const isPeriodic = kind === "periodic";
      periodicCalls += Number(isPeriodic);
      return isPeriodic && periodicCalls === 5 ? failAtCollision[failure]() : true;
    });
    const progress = startTestProgress(
      "runner comparison fallback",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    for (let index = 0; index < 5; index += 1) harness.state.fireNext();
    expect(harness.state.now()).toBe(300_000);
    expect(harness.state.legacySamples).toEqual(["build Hermes image"]);
    expect(harness.state.nextTimerAt()).toBe(900_000);
    harness.state.fireNext();
    expect(periodicCalls).toBe(5);
    expect(harness.state.legacySamples).toEqual(["build Hermes image", "build Hermes image"]);
    progress.stop();
  });

  it("skips missed periodic slots after a blocking collector instead of catching up (#7146)", () => {
    const periodicStarts: number[] = [];
    let state: ReturnType<typeof progressHarness>["state"];
    const harness = progressHarness((_phase, kind) => {
      const blockingDelayMs = Number(kind === "periodic") * 130_000;
      kind === "periodic" ? periodicStarts.push(state.now()) : undefined;
      state.setClock(state.now() + blockingDelayMs);
      return true;
    });
    state = harness.state;
    const progress = startTestProgress(
      "runner comparison catchup",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    state.fireNext();
    expect(periodicStarts).toEqual([60_000]);
    expect(state.now()).toBe(190_000);
    expect(state.nextTimerAt()).toBe(240_000);
    state.fireNext();
    expect(periodicStarts).toEqual([60_000, 240_000]);
    progress.stop();
  });

  it("keeps the initial cadence anchored when the scenario-start probe blocks (#7146)", () => {
    const records: Array<{ atMs: number; kind: string }> = [];
    let state: ReturnType<typeof progressHarness>["state"];
    const harness = progressHarness((_phase, kind) => {
      records.push({ atMs: state.now(), kind });
      state.setClock(state.now() + Number(kind === "scenario-start") * 5_000);
      return true;
    });
    state = harness.state;
    const progress = startTestProgress(
      "runner comparison startup",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    expect(state.now()).toBe(5_000);
    expect(state.nextTimerAt()).toBe(60_000);
    state.fireNext();
    expect(records.at(-1)).toEqual({ atMs: 60_000, kind: "periodic" });
    progress.stop();
  });

  it("lets a boundary probe crossing a cadence deadline consume that slot (#7146)", () => {
    const records: Array<{ atMs: number; kind: string; phase: string }> = [];
    let state: ReturnType<typeof progressHarness>["state"];
    const harness = progressHarness((phase, kind) => {
      records.push({ atMs: state.now(), kind, phase });
      const crossesDeadline = kind === "phase" && records.length === 2;
      state.setClock(crossesDeadline ? 64_000 : state.now());
      return true;
    });
    state = harness.state;
    const progress = startTestProgress(
      "runner comparison phase collision",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    state.setClock(59_000);
    progress.phase("validate Hermes sandbox");
    expect(records).toEqual([
      { atMs: 0, kind: "scenario-start", phase: "build Hermes image" },
      { atMs: 59_000, kind: "phase", phase: "build Hermes image" },
    ]);
    expect(state.nextTimerAt()).toBe(120_000);
    state.fireNext();
    expect(records.at(-1)).toEqual({
      atMs: 120_000,
      kind: "periodic",
      phase: "validate Hermes sandbox",
    });
    progress.stop();
  });

  it("generation-guards an uncleared timer without creating a second handle (#7146)", () => {
    const records: string[] = [];
    const harness = progressHarness((phase, kind) => {
      records.push(`${kind}:${phase}`);
      return true;
    }, 1);
    const progress = startTestProgress(
      "runner comparison stale callback",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    harness.state.setClock(30_000);
    expect(() => progress.phase("validate Hermes sandbox")).not.toThrow();
    expect(harness.state.activeTimers()).toBe(1);
    harness.state.fireNext();
    expect(records.filter((entry) => entry.startsWith("periodic:"))).toHaveLength(0);
    expect(harness.state.activeTimers()).toBe(1);
    harness.state.fireNext();
    expect(records.at(-1)).toBe("periodic:validate Hermes sandbox");
    expect(harness.state.maximumActiveTimers()).toBe(1);
    progress.stop();
    expect(harness.state.activeTimers()).toBe(0);
  });

  it("keeps stop best-effort when timer cancellation throws (#7146)", () => {
    const harness = progressHarness(() => true, 1);
    const progress = startTestProgress(
      "runner comparison stop",
      ["build Hermes image", "validate Hermes sandbox"],
      harness.options,
    );

    harness.state.setClock(10_000);
    expect(() => progress.stop()).not.toThrow();
    expect(harness.state.activeTimers()).toBe(1);
    harness.state.fireNext();
    expect(harness.state.activeTimers()).toBe(0);
  });

  it("keeps start, phase changes, and stop best-effort when timer creation fails (#7146)", () => {
    let timerCalls = 0;
    let clockMs = 0;
    expect(() => {
      const progress = startTestProgress(
        "runner comparison timer creation",
        ["build Hermes image", "validate Hermes sandbox"],
        {
          now: () => clockMs,
          setTimer: () => {
            timerCalls += 1;
            return timerCalls === 1
              ? fail("synthetic timer failure")
              : {
                  unref() {
                    throw new Error("synthetic unref failure");
                  },
                };
          },
          clearTimer: () => undefined,
          logLine: () => undefined,
          recordResourceSample: () => true,
        },
      );
      clockMs = 1_000;
      progress.phase("validate Hermes sandbox");
      clockMs = 2_000;
      progress.stop();
    }).not.toThrow();
    expect(timerCalls).toBe(2);
  });
});
