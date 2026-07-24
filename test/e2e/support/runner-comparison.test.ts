// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createPrivateRegularFile } from "../../../tools/e2e/private-file.mts";
import {
  collectRunnerComparisonSample,
  parseComparisonMeminfo,
  parseCpuStat,
  parseRunnerComparisonLedger,
  parseRunnerComparisonSample,
  parseRunnerComparisonSummary,
  RUNNER_COMPARISON_LEDGER_FILE,
  RUNNER_COMPARISON_MAX_SAMPLES,
  RUNNER_COMPARISON_SUMMARY_FILE,
  type RunnerComparisonSample,
  type RunnerComparisonSampleV1,
  type RunnerComparisonSummary,
  renderRunnerComparisonSummary,
  summarizeRunnerComparison,
} from "../../../tools/e2e/runner-comparison-core.mts";
import type { ResourceSnapshot } from "../../../tools/e2e/runner-pressure-core.mts";

const REPO_ROOT = process.cwd();
const TSX_IMPORT = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const CLI = path.join(REPO_ROOT, "tools", "e2e", "runner-comparison.mts");

function sample(overrides: Partial<RunnerComparisonSampleV1> = {}): RunnerComparisonSampleV1 {
  return {
    v: 1,
    at: "2026-07-22T10:00:00.000Z",
    target: "rebuild-hermes",
    shard: "hosted",
    cpu: { logicalCpuCount: 4, idleTicks: 40, totalTicks: 100 },
    memory: { totalKb: 1_000, availableKb: 800, rootCgroupPeakBytes: 1_000 },
    workspace: { totalBytes: 10_000, freeBytes: 8_000 },
    ...overrides,
  };
}

function ledger(...samples: RunnerComparisonSampleV1[]): string {
  return `${samples.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

type CurrentOverrides = Partial<
  Omit<
    RunnerComparisonSample,
    "cpu" | "load" | "memory" | "pressure" | "workspace" | "docker" | "largestProcess"
  >
> & {
  cpu?: RunnerComparisonSample["cpu"];
  load?: Partial<RunnerComparisonSample["load"]>;
  memory?: Partial<RunnerComparisonSample["memory"]>;
  pressure?: Partial<RunnerComparisonSample["pressure"]>;
  workspace?: Partial<RunnerComparisonSample["workspace"]>;
  docker?: Partial<RunnerComparisonSample["docker"]>;
  largestProcess?: RunnerComparisonSample["largestProcess"];
};

function currentSample(overrides: CurrentOverrides = {}): RunnerComparisonSample {
  const base: RunnerComparisonSample = {
    v: 2,
    sequence: 0,
    kind: "initialize",
    phase: null,
    at: "2026-07-22T10:00:00.000Z",
    target: "rebuild-hermes",
    shard: "hosted",
    cpu: { logicalCpuCount: 4, idleTicks: 40, totalTicks: 100 },
    load: { oneMinute: 1, fiveMinutes: 1, fifteenMinutes: 1 },
    memory: {
      totalKb: 1_000,
      availableKb: 800,
      cachedKb: 100,
      sReclaimableKb: 20,
      swapTotalKb: 500,
      swapFreeKb: 500,
      rootCgroupCurrentBytes: 100,
      rootCgroupPeakBytes: 100,
      rootCgroupLimitBytes: 2_000,
      rootCgroupOom: 0,
      rootCgroupOomKill: 0,
    },
    pressure: { memoryFullAvg60: 0, ioFullAvg60: 0 },
    workspace: {
      totalBytes: 10_000,
      freeBytes: 8_000,
      inodesTotal: 1_000,
      inodesFree: 800,
    },
    docker: {
      imagesBytes: null,
      containersBytes: null,
      buildCacheBytes: null,
      maximumContainerMemoryBytes: null,
      maximumContainerCpuPercent: null,
    },
    largestProcess: null,
  };
  return {
    ...base,
    ...overrides,
    load: { ...base.load, ...overrides.load },
    memory: { ...base.memory, ...overrides.memory },
    pressure: { ...base.pressure, ...overrides.pressure },
    workspace: { ...base.workspace, ...overrides.workspace },
    docker: { ...base.docker, ...overrides.docker },
  };
}

function currentLedger(...samples: RunnerComparisonSample[]): string {
  return `${samples.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function emptyCurrentSample(
  sequence: number,
  kind: RunnerComparisonSample["kind"],
): RunnerComparisonSample {
  return currentSample({
    sequence,
    kind,
    phase: kind === "initialize" || kind === "finalize" ? null : "build",
    at: new Date(Date.parse("2026-07-22T10:00:00.000Z") + sequence).toISOString(),
    cpu: null,
    load: { oneMinute: null, fiveMinutes: null, fifteenMinutes: null },
    memory: {
      totalKb: null,
      availableKb: null,
      cachedKb: null,
      sReclaimableKb: null,
      swapTotalKb: null,
      swapFreeKb: null,
      rootCgroupCurrentBytes: null,
      rootCgroupPeakBytes: null,
      rootCgroupLimitBytes: null,
      rootCgroupOom: null,
      rootCgroupOomKill: null,
    },
    pressure: { memoryFullAvg60: null, ioFullAvg60: null },
    workspace: {
      totalBytes: null,
      freeBytes: null,
      inodesTotal: null,
      inodesFree: null,
    },
  });
}

function runCli(
  cwd: string,
  mode: string | string[],
  environment: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const arguments_ = Array.isArray(mode) ? mode : [mode];
  return spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...arguments_], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      E2E_ARTIFACT_DIR: "artifacts",
      E2E_TARGET_ID: "rebuild-hermes",
      NEMOCLAW_E2E_SHARD: "hosted",
      ...environment,
    },
  });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function expectCurrentSummary(
  summary: ReturnType<typeof summarizeRunnerComparison>,
): RunnerComparisonSummary {
  expect(summary.v).toBe(2);
  return summary as RunnerComparisonSummary;
}

describe("runner comparison collection", () => {
  it("parses Linux CPU and memory sources without subprocesses (#7145)", () => {
    expect(
      parseCpuStat(
        "cpu  100 20 30 400 50 6 7 8 9 10\ncpu0 1 2 3 4 5 6 7 8\ncpu1 1 2 3 4 5 6 7 8\n",
      ),
    ).toEqual({ logicalCpuCount: 2, idleTicks: 450, totalTicks: 621 });
    expect(parseCpuStat("cpu malformed\n")).toBeNull();
    expect(parseComparisonMeminfo("MemTotal: 16384 kB\nMemAvailable: 4096 kB\n")).toEqual({
      totalKb: 16_384,
      availableKb: 4_096,
    });
    expect(parseComparisonMeminfo("MemFree: 12 kB\n")).toEqual({
      totalKb: null,
      availableKb: null,
    });
  });

  it("maps the secret-safe pressure snapshot without reconstructing raw strings (#7146)", () => {
    const snapshot: ResourceSnapshot = {
      phase: "build",
      at: "2026-07-22T10:00:00.000Z",
      cpu: { logicalCpuCount: 4, idleTicks: 450, totalTicks: 621 },
      load: { load1: 2.5, load5: 1.5, load15: 1 },
      meminfo: {
        memTotalKb: 8192,
        memFreeKb: 1024,
        memAvailableKb: 3072,
        cachedKb: 2048,
        sReclaimableKb: 512,
        swapTotalKb: 4096,
        swapFreeKb: 3072,
      },
      cgroup: {
        currentBytes: 120_000,
        peakBytes: 123_456,
        limitBytes: 1_000_000,
        events: { oom: 2, oomKill: 1 },
      },
      memoryPressure: { someAvg10: 1, someAvg60: 1, fullAvg10: 2, fullAvg60: 2 },
      ioPressure: { someAvg10: 3, someAvg60: 3, fullAvg10: 4, fullAvg60: 4 },
      topProcesses: [{ rssKb: 999 }],
      largestProcess: { class: "docker-buildkit", rssKb: 999 },
      containers: [
        { cpuPercent: 12.5, memBytes: 500, memLimitBytes: 1_000 },
        { cpuPercent: 3, memBytes: 700, memLimitBytes: 1_000 },
      ],
      maximumContainerCpuPercent: 99,
      dockerDisk: { imagesBytes: 100, containersBytes: 200, buildCacheBytes: 300 },
      disk: { totalBytes: 409_600, freeBytes: 102_400, inodesTotal: 1000, inodesFree: 250 },
    };

    expect(
      collectRunnerComparisonSample(
        { target: "rebuild-hermes", shard: "hosted" },
        { sequence: 1, kind: "phase", phase: "build" },
        snapshot,
      ),
    ).toEqual({
      v: 2,
      sequence: 1,
      kind: "phase",
      phase: "build",
      at: "2026-07-22T10:00:00.000Z",
      target: "rebuild-hermes",
      shard: "hosted",
      cpu: { logicalCpuCount: 4, idleTicks: 450, totalTicks: 621 },
      load: { oneMinute: 2.5, fiveMinutes: 1.5, fifteenMinutes: 1 },
      memory: {
        totalKb: 8192,
        availableKb: 3072,
        cachedKb: 2048,
        sReclaimableKb: 512,
        swapTotalKb: 4096,
        swapFreeKb: 3072,
        rootCgroupCurrentBytes: 120_000,
        rootCgroupPeakBytes: 123_456,
        rootCgroupLimitBytes: 1_000_000,
        rootCgroupOom: 2,
        rootCgroupOomKill: 1,
      },
      pressure: { memoryFullAvg60: 2, ioFullAvg60: 4 },
      workspace: {
        totalBytes: 409_600,
        freeBytes: 102_400,
        inodesTotal: 1000,
        inodesFree: 250,
      },
      docker: {
        imagesBytes: 100,
        containersBytes: 200,
        buildCacheBytes: 300,
        maximumContainerMemoryBytes: 700,
        maximumContainerCpuPercent: 99,
      },
      largestProcess: { class: "docker-buildkit", rssKb: 999 },
    });
  });
});

describe("runner comparison schema", () => {
  it("rejects unknown fields so secret-bearing strings cannot enter the artifact (#7145)", () => {
    expect(() =>
      parseRunnerComparisonSample(JSON.stringify({ ...sample(), token: "ghp_do-not-record" })),
    ).toThrow("unsupported shape");
    const valid = sample();
    expect(() =>
      parseRunnerComparisonSample(
        JSON.stringify({ ...valid, memory: { ...valid.memory, command: "docker login secret" } }),
      ),
    ).toThrow("unsupported shape");
  });

  it("rejects duplicate JSON keys that could hide non-canonical artifact text (#7145)", () => {
    const canonical = JSON.stringify(sample());
    const duplicate = canonical.replace(
      '"target":"rebuild-hermes"',
      '"target":"sensitive-value","target":"rebuild-hermes"',
    );

    expect(() => parseRunnerComparisonSample(duplicate)).toThrow("canonical JSON encoding");
  });

  it.each([
    ["non-canonical timestamp", { at: "2026-07-22T10:00:00Z" }],
    ["impossible timestamp", { at: "2026-02-30T10:00:00.000Z" }],
    ["negative CPU counter", { cpu: { logicalCpuCount: 4, idleTicks: -1, totalTicks: 100 } }],
    ["fractional memory", { memory: { totalKb: 1.5, availableKb: 1, rootCgroupPeakBytes: 1 } }],
    ["excess free disk", { workspace: { totalBytes: 10, freeBytes: 11 } }],
  ])("rejects a %s (#7145)", (_label, override) => {
    expect(() => parseRunnerComparisonSample(JSON.stringify(sample(override)))).toThrow();
  });

  it("rejects ledgers with more than two samples (#7145)", () => {
    const start = sample();
    const middle = sample({ at: "2026-07-22T10:01:00.000Z" });
    const finish = sample({ at: "2026-07-22T10:02:00.000Z" });
    expect(() => parseRunnerComparisonLedger(ledger(start, middle, finish))).toThrow(
      "one or two samples",
    );
  });

  it("rejects non-canonical JSONL separators and empty records (#7145)", () => {
    expect(() => parseRunnerComparisonLedger(`${ledger(sample())}\n`)).toThrow(
      "canonical JSONL encoding",
    );
    expect(() => parseRunnerComparisonLedger(ledger(sample()).replaceAll("\n", "\r\n"))).toThrow(
      "canonical JSONL encoding",
    );
  });

  it.each([
    ["target identity", { target: "hermes-e2e", at: "2026-07-22T10:01:00.000Z" }],
    ["shard identity", { shard: "anthropic", at: "2026-07-22T10:01:00.000Z" }],
    ["timestamp order", { at: "2026-07-22T10:00:00.000Z" }],
    [
      "CPU capacity",
      {
        at: "2026-07-22T10:01:00.000Z",
        cpu: { logicalCpuCount: 8, idleTicks: 50, totalTicks: 120 },
      },
    ],
    [
      "CPU counters",
      {
        at: "2026-07-22T10:01:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 39, totalTicks: 99 },
      },
    ],
  ])("rejects ledger %s drift (#7145)", (_label, override) => {
    expect(() => parseRunnerComparisonLedger(ledger(sample(), sample(override)))).toThrow();
  });
});

describe("runner comparison v2 schema", () => {
  it("accepts a bounded initialize/start/periodic/phase/finalize ledger (#7146)", () => {
    const samples = [
      currentSample(),
      currentSample({
        sequence: 1,
        kind: "scenario-start",
        phase: "build",
        at: "2026-07-22T10:00:30.000Z",
        cpu: null,
      }),
      currentSample({
        sequence: 2,
        kind: "periodic",
        phase: "build",
        at: "2026-07-22T10:01:00.000Z",
        cpu: null,
      }),
      currentSample({
        sequence: 3,
        kind: "phase",
        phase: "build",
        at: "2026-07-22T10:02:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 80, totalTicks: 200 },
      }),
      currentSample({
        sequence: 4,
        kind: "finalize",
        at: "2026-07-22T10:03:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 120, totalTicks: 300 },
      }),
    ];

    expect(parseRunnerComparisonLedger(currentLedger(...samples))).toEqual(samples);
  });

  it.each([
    [
      "zero logical CPUs",
      currentSample({ cpu: { logicalCpuCount: 0, idleTicks: 0, totalTicks: 0 } }),
    ],
    ["excess swap free", currentSample({ memory: { swapTotalKb: 1, swapFreeKb: 2 } })],
    [
      "cgroup current above peak",
      currentSample({ memory: { rootCgroupCurrentBytes: 101, rootCgroupPeakBytes: 100 } }),
    ],
    ["PSI above 100", currentSample({ pressure: { memoryFullAvg60: 100.1 } })],
    ["excess free inodes", currentSample({ workspace: { inodesTotal: 10, inodesFree: 11 } })],
    [
      "raw process name",
      currentSample({
        kind: "phase",
        phase: "build",
        largestProcess: { class: "secret command" as "other", rssKb: 10 },
      }),
    ],
    ["Docker evidence at an endpoint", currentSample({ docker: { imagesBytes: 1 } })],
  ])("rejects %s (#7146)", (_label, candidate) => {
    expect(() => parseRunnerComparisonSample(JSON.stringify(candidate))).toThrow();
  });

  it("rejects mixed versions, sequence drift, and CPU corruption across null gaps (#7146)", () => {
    expect(() =>
      parseRunnerComparisonLedger(
        `${JSON.stringify(sample())}\n${JSON.stringify(currentSample())}\n`,
      ),
    ).toThrow("must not mix schema versions");

    const sequenceDrift = currentSample({
      sequence: 2,
      kind: "periodic",
      phase: "build",
      at: "2026-07-22T10:01:00.000Z",
    });
    expect(() =>
      parseRunnerComparisonLedger(currentLedger(currentSample(), sequenceDrift)),
    ).toThrow("sequence");

    const missing = currentSample({
      sequence: 1,
      kind: "periodic",
      phase: "build",
      at: "2026-07-22T10:01:00.000Z",
      cpu: null,
    });
    const invalidFinal = currentSample({
      sequence: 2,
      kind: "finalize",
      at: "2026-07-22T10:02:00.000Z",
      cpu: { logicalCpuCount: 4, idleTicks: 51, totalTicks: 110 },
    });
    expect(() =>
      parseRunnerComparisonLedger(currentLedger(currentSample(), missing, invalidFinal)),
    ).toThrow("CPU counters");
  });

  it("caps ledgers at 256 samples (#7146)", () => {
    const samples = Array.from({ length: RUNNER_COMPARISON_MAX_SAMPLES + 1 }, (_, sequence) =>
      currentSample({
        sequence,
        kind: sequence === 0 ? "initialize" : "periodic",
        phase: sequence === 0 ? null : "build",
        at: new Date(Date.parse("2026-07-22T10:00:00.000Z") + sequence).toISOString(),
        cpu: null,
      }),
    );
    expect(() => parseRunnerComparisonLedger(currentLedger(...samples))).toThrow(
      "between one and 256",
    );
  });
});

describe("runner comparison summary", () => {
  it("reduces post-prepare CPU, memory, and workspace deltas (#7145)", () => {
    const summary = summarizeRunnerComparison([
      sample(),
      sample({
        at: "2026-07-22T10:02:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 100, totalTicks: 300 },
        memory: { totalKb: 1_000, availableKb: 600, rootCgroupPeakBytes: 1_500 },
        workspace: { totalBytes: 10_000, freeBytes: 6_500 },
      }),
    ]);

    expect(summary).toMatchObject({
      durationMs: 120_000,
      sampleCount: 2,
      cpu: { logicalCpuCount: 4, averageBusyPercent: 70, averageBusyLogicalCpus: 2.8 },
      memory: {
        totalKb: 1_000,
        startAvailableKb: 800,
        endAvailableKb: 600,
        maximumEndpointUsedKb: 400,
        rootCgroupPeakBytes: 1_500,
      },
      workspace: {
        totalBytes: 10_000,
        startFreeBytes: 8_000,
        endFreeBytes: 6_500,
        netGrowthBytes: 1_500,
        minimumEndpointFreeBytes: 6_500,
      },
    });
  });

  it("uses explicit nulls when comparison inputs are unavailable or inconsistent (#7145)", () => {
    const missing = {
      cpu: null,
      memory: { totalKb: null, availableKb: null, rootCgroupPeakBytes: null },
      workspace: { totalBytes: null, freeBytes: null },
    } as const;
    const summary = summarizeRunnerComparison([
      sample(missing),
      sample({ ...missing, at: "2026-07-22T10:01:00.000Z" }),
    ]);

    expect(summary.cpu).toEqual({
      logicalCpuCount: null,
      averageBusyPercent: null,
      averageBusyLogicalCpus: null,
    });
    expect(summary.memory).toMatchObject({ totalKb: null, maximumEndpointUsedKb: null });
    expect(summary.workspace).toMatchObject({ totalBytes: null, netGrowthBytes: null });
  });

  it("attributes transition peaks and CPU windows to the completed phase (#7146)", () => {
    const samples = [
      currentSample(),
      currentSample({
        sequence: 1,
        kind: "scenario-start",
        phase: "build",
        at: "2026-07-22T10:00:10.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 45, totalTicks: 120 },
      }),
      currentSample({
        sequence: 2,
        kind: "phase",
        phase: "build",
        at: "2026-07-22T10:01:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 55, totalTicks: 220 },
        memory: {
          availableKb: 100,
          cachedKb: 300,
          sReclaimableKb: 100,
          swapFreeKb: 50,
          rootCgroupCurrentBytes: 900,
          rootCgroupPeakBytes: 950,
        },
        pressure: { memoryFullAvg60: 80, ioFullAvg60: 70 },
        workspace: { freeBytes: 2_000, inodesFree: 100 },
        docker: {
          imagesBytes: 1_000,
          containersBytes: 2_000,
          buildCacheBytes: 3_000,
          maximumContainerMemoryBytes: 900,
          maximumContainerCpuPercent: 80,
        },
        largestProcess: { class: "docker-buildkit", rssKb: 999 },
      }),
      currentSample({
        sequence: 3,
        kind: "phase",
        phase: "test",
        at: "2026-07-22T10:02:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 145, totalTicks: 320 },
        memory: {
          availableKb: 400,
          cachedKb: 200,
          sReclaimableKb: 50,
          swapFreeKb: 300,
          rootCgroupCurrentBytes: 400,
          rootCgroupPeakBytes: 950,
        },
        pressure: { memoryFullAvg60: 10, ioFullAvg60: 10 },
        workspace: { freeBytes: 5_000, inodesFree: 500 },
        docker: {
          imagesBytes: 500,
          containersBytes: 500,
          buildCacheBytes: 500,
          maximumContainerMemoryBytes: 500,
          maximumContainerCpuPercent: 10,
        },
        largestProcess: { class: "openshell", rssKb: 500 },
      }),
      currentSample({
        sequence: 4,
        kind: "finalize",
        at: "2026-07-22T10:03:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 235, totalTicks: 420 },
        memory: {
          availableKb: 500,
          cachedKb: 150,
          sReclaimableKb: 25,
          swapFreeKb: 400,
          rootCgroupCurrentBytes: 500,
          rootCgroupPeakBytes: 950,
        },
        workspace: { freeBytes: 6_000, inodesFree: 600 },
      }),
    ];

    const summary = expectCurrentSummary(summarizeRunnerComparison(samples));
    expect(summary.cpu.maximumBusy).toEqual({ percent: 90, phase: "build" });
    expect(summary.memory.minimumAvailable).toEqual({ kb: 100, phase: "build" });
    expect(summary.memory.maximumSwapUsed).toEqual({ kb: 450, phase: "build" });
    expect(summary.memory.cgroup.maximumCurrent).toEqual({ bytes: 900, phase: "build" });
    expect(summary.pressure.maximumMemoryFullAvg60).toEqual({ percent: 80, phase: "build" });
    expect(summary.workspace.minimumFree).toEqual({ bytes: 2_000, phase: "build" });
    expect(summary.docker.maximumBuildCache).toEqual({ bytes: 3_000, phase: "build" });
    expect(summary.docker.maximumContainerMemory).toEqual({ bytes: 900, phase: "build" });
    expect(summary.largestProcess).toEqual({
      class: "docker-buildkit",
      rssKb: 999,
      phase: "build",
    });
  });

  it("keeps the initialize-to-startup CPU window unattributed (#7146)", () => {
    const summary = expectCurrentSummary(
      summarizeRunnerComparison([
        currentSample(),
        currentSample({
          sequence: 1,
          kind: "scenario-start",
          phase: "build",
          at: "2026-07-22T10:01:00.000Z",
          cpu: { logicalCpuCount: 4, idleTicks: 45, totalTicks: 200 },
        }),
        currentSample({
          sequence: 2,
          kind: "phase",
          phase: "build",
          at: "2026-07-22T10:02:00.000Z",
          cpu: { logicalCpuCount: 4, idleTicks: 135, totalTicks: 300 },
        }),
        currentSample({
          sequence: 3,
          kind: "finalize",
          at: "2026-07-22T10:03:00.000Z",
          cpu: { logicalCpuCount: 4, idleTicks: 225, totalTicks: 400 },
        }),
      ]),
    );
    expect(summary.cpu.maximumBusy).toEqual({ percent: 95, phase: null });
  });

  it("keeps CPU windows before every scenario start unattributed across one job ledger (#7146)", () => {
    const twoScenarioLedger = (secondStartIdleTicks: number) => [
      currentSample(),
      currentSample({
        sequence: 1,
        kind: "scenario-start" as const,
        phase: "build-one",
        at: "2026-07-22T10:01:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 45, totalTicks: 200 },
      }),
      currentSample({
        sequence: 2,
        kind: "phase" as const,
        phase: "teardown-one",
        at: "2026-07-22T10:02:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 135, totalTicks: 300 },
      }),
      currentSample({
        sequence: 3,
        kind: "scenario-start" as const,
        phase: "build-two",
        at: "2026-07-22T10:03:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: secondStartIdleTicks, totalTicks: 500 },
        memory: { availableKb: 100 },
      }),
      currentSample({
        sequence: 4,
        kind: "phase" as const,
        phase: "build-two",
        at: "2026-07-22T10:04:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: secondStartIdleTicks + 90, totalTicks: 600 },
      }),
      currentSample({
        sequence: 5,
        kind: "finalize" as const,
        at: "2026-07-22T10:05:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: secondStartIdleTicks + 180, totalTicks: 700 },
      }),
    ];

    const firstStartWins = expectCurrentSummary(summarizeRunnerComparison(twoScenarioLedger(335)));
    const secondStartWins = expectCurrentSummary(summarizeRunnerComparison(twoScenarioLedger(141)));
    expect(firstStartWins.cpu.maximumBusy).toEqual({ percent: 95, phase: null });
    expect(secondStartWins.cpu.maximumBusy).toEqual({ percent: 97, phase: null });
    expect(secondStartWins.memory.minimumAvailable).toEqual({
      kb: 100,
      phase: "build-two",
    });
  });

  it("leaves initialize extrema unattributed and requires complete validated ledgers (#7146)", () => {
    const initialize = currentSample({ load: { oneMinute: 99 } });
    const phase = currentSample({
      sequence: 1,
      kind: "scenario-start",
      phase: "build",
      at: "2026-07-22T10:01:00.000Z",
      cpu: { logicalCpuCount: 4, idleTicks: 80, totalTicks: 200 },
    });
    const finalize = currentSample({
      sequence: 2,
      kind: "finalize",
      at: "2026-07-22T10:02:00.000Z",
      cpu: { logicalCpuCount: 4, idleTicks: 120, totalTicks: 300 },
    });
    const summary = expectCurrentSummary(summarizeRunnerComparison([initialize, phase, finalize]));
    expect(summary.load.maximumOneMinute).toEqual({ value: 99, phase: null });
    expect(() => summarizeRunnerComparison([initialize, phase])).toThrow("final sample");
    expect(() =>
      summarizeRunnerComparison([initialize, { ...finalize, sequence: 1, target: "other-target" }]),
    ).toThrow("identity");
  });

  it("reports OOM deltas only when both endpoint counters are available (#7146)", () => {
    const initialize = currentSample({
      memory: { rootCgroupOom: null, rootCgroupOomKill: null },
    });
    const phase = currentSample({
      sequence: 1,
      kind: "scenario-start",
      phase: "build",
      at: "2026-07-22T10:01:00.000Z",
      memory: { rootCgroupOom: 4, rootCgroupOomKill: 2 },
    });
    const finalize = currentSample({
      sequence: 2,
      kind: "finalize",
      at: "2026-07-22T10:02:00.000Z",
      memory: { rootCgroupOom: 5, rootCgroupOomKill: 2 },
    });
    const summary = expectCurrentSummary(summarizeRunnerComparison([initialize, phase, finalize]));
    expect(summary.memory.cgroup).toMatchObject({ oomDelta: null, oomKillDelta: null });
  });

  it("strictly validates historical and current summary shapes and derived fields (#7146)", () => {
    const legacy = summarizeRunnerComparison([
      sample(),
      sample({
        at: "2026-07-22T10:01:00.000Z",
        cpu: { logicalCpuCount: 4, idleTicks: 60, totalTicks: 200 },
      }),
    ]);
    expect(parseRunnerComparisonSummary(renderRunnerComparisonSummary(legacy))).toEqual(legacy);
    const poisonedLegacy = structuredClone(legacy);
    poisonedLegacy.cpu.averageBusyPercent = -1;
    expect(() =>
      parseRunnerComparisonSummary(`${JSON.stringify(poisonedLegacy, null, 2)}\n`),
    ).toThrow();

    const current = expectCurrentSummary(
      summarizeRunnerComparison([
        currentSample(),
        currentSample({
          sequence: 1,
          kind: "finalize",
          at: "2026-07-22T10:01:00.000Z",
          cpu: { logicalCpuCount: 4, idleTicks: 60, totalTicks: 200 },
        }),
      ]),
    );
    expect(parseRunnerComparisonSummary(renderRunnerComparisonSummary(current))).toEqual(current);
    const poisonedCurrent = structuredClone(current);
    poisonedCurrent.memory.totalKb = null;
    expect(() =>
      parseRunnerComparisonSummary(`${JSON.stringify(poisonedCurrent, null, 2)}\n`),
    ).toThrow("requires totalKb");
    const poisonedGrowth = structuredClone(current);
    poisonedGrowth.workspace.startFreeBytes = null;
    expect(() =>
      parseRunnerComparisonSummary(`${JSON.stringify(poisonedGrowth, null, 2)}\n`),
    ).toThrow("requires both endpoint");
  });
});

describe("runner comparison private artifacts", () => {
  it("creates a new private regular file and refuses every existing path (#7145)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-create-"));
    try {
      const file = path.join(directory, "sample.jsonl");
      createPrivateRegularFile(file, "first\n");
      expect(fs.readFileSync(file, "utf8")).toBe("first\n");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => createPrivateRegularFile(file, "replacement\n")).toThrow();

      const target = path.join(directory, "target");
      fs.writeFileSync(target, "target\n");
      const symbolic = path.join(directory, "symbolic");
      fs.symlinkSync(target, symbolic);
      expect(() => createPrivateRegularFile(symbolic, "replacement\n")).toThrow();
      const hard = path.join(directory, "hard");
      fs.linkSync(target, hard);
      expect(() => createPrivateRegularFile(hard, "replacement\n")).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("initializes and finalizes exactly two mode-0600 samples plus a summary (#7145)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-comparison-"));
    try {
      expectSuccess(runCli(directory, "initialize"));
      expectSuccess(runCli(directory, "finalize"));
      const artifacts = path.join(directory, "artifacts");
      const ledgerPath = path.join(artifacts, RUNNER_COMPARISON_LEDGER_FILE);
      const summaryPath = path.join(artifacts, RUNNER_COMPARISON_SUMMARY_FILE);
      const samples = parseRunnerComparisonLedger(fs.readFileSync(ledgerPath, "utf8"));
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

      expect(samples).toHaveLength(2);
      expect(summary).toMatchObject({
        v: 2,
        target: "rebuild-hermes",
        shard: "hosted",
        sampleCount: 2,
      });
      expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(summaryPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends a periodic sample to the canonical ledger and logs every record (#7146)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-periodic-"));
    try {
      const initialized = runCli(directory, "initialize");
      const periodic = runCli(directory, ["sample", "periodic", "build"]);
      const finalized = runCli(directory, "finalize");
      expectSuccess(initialized);
      expectSuccess(periodic);
      expectSuccess(finalized);
      expect(initialized.stdout).toContain("E2E_RUNNER_COMPARISON_SAMPLE ");
      expect(periodic.stdout).toContain('"kind":"periodic"');
      expect(finalized.stdout).toContain('"kind":"finalize"');
      const artifacts = path.join(directory, "artifacts");
      const samples = parseRunnerComparisonLedger(
        fs.readFileSync(path.join(artifacts, RUNNER_COMPARISON_LEDGER_FILE), "utf8"),
      );
      const summary = parseRunnerComparisonSummary(
        fs.readFileSync(path.join(artifacts, RUNNER_COMPARISON_SUMMARY_FILE), "utf8"),
      );
      expect(samples).toHaveLength(3);
      expect(summary.sampleCount).toBe(3);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reserves the final ledger slot and fails closed on historical ledgers (#7146)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-cap-"));
    try {
      const artifacts = path.join(directory, "artifacts");
      fs.mkdirSync(artifacts, { recursive: true });
      const ledgerPath = path.join(artifacts, RUNNER_COMPARISON_LEDGER_FILE);
      const capped = Array.from({ length: RUNNER_COMPARISON_MAX_SAMPLES - 1 }, (_, sequence) =>
        emptyCurrentSample(sequence, sequence === 0 ? "initialize" : "periodic"),
      );
      fs.writeFileSync(ledgerPath, currentLedger(...capped), { mode: 0o600 });
      const before = fs.readFileSync(ledgerPath, "utf8");
      expect(runCli(directory, ["sample", "periodic", "build"]).status).toBe(1);
      expect(fs.readFileSync(ledgerPath, "utf8")).toBe(before);
      expectSuccess(runCli(directory, "finalize"));
      expect(parseRunnerComparisonLedger(fs.readFileSync(ledgerPath, "utf8"))).toHaveLength(
        RUNNER_COMPARISON_MAX_SAMPLES,
      );

      const historicalDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-runner-historical-"),
      );
      try {
        const historicalArtifacts = path.join(historicalDirectory, "artifacts");
        fs.mkdirSync(historicalArtifacts, { recursive: true });
        const historicalPath = path.join(historicalArtifacts, RUNNER_COMPARISON_LEDGER_FILE);
        fs.writeFileSync(historicalPath, ledger(sample()), { mode: 0o600 });
        const historical = fs.readFileSync(historicalPath, "utf8");
        expect(runCli(historicalDirectory, ["sample", "periodic", "build"]).status).toBe(1);
        expect(fs.readFileSync(historicalPath, "utf8")).toBe(historical);
      } finally {
        fs.rmSync(historicalDirectory, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate initialization (#7145)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-duplicate-"));
    try {
      expectSuccess(runCli(directory, "initialize"));
      expect(runCli(directory, "initialize").status).not.toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      kind: "symlink",
      replace: (ledgerPath: string, replacement: string) => {
        fs.writeFileSync(replacement, fs.readFileSync(ledgerPath));
        fs.unlinkSync(ledgerPath);
        fs.symlinkSync(replacement, ledgerPath);
      },
    },
    {
      kind: "hardlink",
      replace: (ledgerPath: string, replacement: string) => {
        fs.linkSync(ledgerPath, replacement);
      },
    },
  ])("rejects a $kind ledger replacement (#7145)", ({ replace }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-link-"));
    try {
      expectSuccess(runCli(directory, "initialize"));
      const ledgerPath = path.join(directory, "artifacts", RUNNER_COMPARISON_LEDGER_FILE);
      const replacement = path.join(directory, "replacement");
      replace(ledgerPath, replacement);
      expect(runCli(directory, "finalize").status).not.toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a nonzero status for an unsupported CLI mode (#7145)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-mode-"));
    try {
      const result = runCli(directory, "sample-continuously");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("<initialize|finalize|sample");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
