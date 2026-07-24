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
  RUNNER_COMPARISON_LEDGER_FILE,
  RUNNER_COMPARISON_SUMMARY_FILE,
  type RunnerComparisonSample,
  summarizeRunnerComparison,
} from "../../../tools/e2e/runner-comparison-core.mts";

const REPO_ROOT = process.cwd();
const TSX_IMPORT = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const CLI = path.join(REPO_ROOT, "tools", "e2e", "runner-comparison.mts");

function sample(overrides: Partial<RunnerComparisonSample> = {}): RunnerComparisonSample {
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

function ledger(...samples: RunnerComparisonSample[]): string {
  return `${samples.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function runCli(
  cwd: string,
  mode: string,
  environment: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, mode], {
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

  it("collects a bounded sample from injected proc, cgroup, clock, and filesystem sources (#7145)", () => {
    const sources = {
      now: () => new Date("2026-07-22T10:00:00.000Z"),
      readText: (file: string) =>
        new Map([
          ["/proc/stat", "cpu  100 20 30 400 50 6 7 8\ncpu0 1 2 3 4 5 6 7 8\n"],
          ["/proc/meminfo", "MemTotal: 8192 kB\nMemAvailable: 3072 kB\n"],
          ["/sys/fs/cgroup/memory.peak", "123456\n"],
        ]).get(file) ?? null,
      statfs: (_directory: string) => ({ blocks: 100, bavail: 25, bsize: 4096 }),
    };

    expect(
      collectRunnerComparisonSample(
        { target: "rebuild-hermes", shard: "hosted" },
        "/workspace",
        sources,
      ),
    ).toEqual({
      v: 1,
      at: "2026-07-22T10:00:00.000Z",
      target: "rebuild-hermes",
      shard: "hosted",
      cpu: { logicalCpuCount: 1, idleTicks: 450, totalTicks: 621 },
      memory: { totalKb: 8192, availableKb: 3072, rootCgroupPeakBytes: 123456 },
      workspace: { totalBytes: 409600, freeBytes: 102400 },
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
        v: 1,
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
      expect(result.stderr).toContain("<initialize|finalize>");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
