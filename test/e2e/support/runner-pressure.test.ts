// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LIVE_TEST_OUTCOME_FILE,
  type LiveTestOutcome,
  renderLiveTestOutcome,
} from "../../../tools/e2e/live-test-outcome.mts";
import {
  assertCanonicalTimestamp,
  assertPhaseLabel,
  BASELINE_LINE_PREFIX,
  CLASSIFICATION_LINE_PREFIX,
  classifyFailure,
  countKernelOomKills,
  decideRetry,
  detectRunnerLoss,
  type FailureEvidence,
  MIN_DISK_FREE_BYTES,
  MIN_INODES_FREE,
  parseBaselineLine,
  parseCgroupMemoryEvents,
  parseCgroupScalar,
  parseClassificationLine,
  parseDockerSize,
  parseDockerStats,
  parseDockerSystemDf,
  parseLoadAverages,
  parseMeminfo,
  parsePressure,
  parseTopProcesses,
  type ResourceSnapshot,
  renderBaselineLine,
  renderClassificationLine,
  renderSnapshotLine,
  SNAPSHOT_LINE_MAX_LENGTH,
  SNAPSHOT_LINE_PREFIX,
  selectFailureBaseline,
} from "../../../tools/e2e/runner-pressure-core.mts";

const HELPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tools/e2e/runner-pressure.mts",
);

const LINK_CREATORS = {
  symlink: (target: string, linkedPath: string) => fs.symlinkSync(target, linkedPath),
  hardlink: (target: string, linkedPath: string) => fs.linkSync(target, linkedPath),
} as const;

function runHelper(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HELPER, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function withEvidenceFiles<T>(
  outcome: LiveTestOutcome,
  callback: (baselinePath: string, outcomePath: string) => T,
): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-pressure-"));
  const baselinePath = path.join(directory, "baseline.jsonl");
  const outcomePath = path.join(directory, LIVE_TEST_OUTCOME_FILE);
  fs.writeFileSync(
    baselinePath,
    `${renderBaselineLine({
      phase: "unit-test",
      at: "2026-07-18T00:00:00.000Z",
      cgroupOomKills: 0,
      kernelOomKillCount: 0,
      containerOomKilled: false,
    })}\n`,
  );
  fs.writeFileSync(outcomePath, renderLiveTestOutcome(outcome), { mode: 0o600 });
  try {
    return callback(baselinePath, outcomePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const MEMINFO_FIXTURE = [
  "MemTotal:       16384000 kB",
  "MemFree:          204800 kB",
  "MemAvailable:   12288000 kB",
  "Cached:         10240000 kB",
  "SReclaimable:     512000 kB",
  "SwapTotal:       4194304 kB",
  "SwapFree:        4194304 kB",
].join("\n");

function baseEvidence(): FailureEvidence {
  return {
    testOutcome: "none",
    cgroupOomKillsBefore: 0,
    cgroupOomKillsAfter: 0,
    kernelOomKillCountBefore: 0,
    kernelOomKillCountAfter: 0,
    containerOomKilledBefore: false,
    containerOomKilledAfter: false,
    memFreeKb: 204800,
    memAvailableKb: 12288000,
    diskFreeBytes: 40 * 1024 ** 3,
    inodesFree: 1_000_000,
  };
}

function baseSnapshot(): ResourceSnapshot {
  return {
    phase: "rebuild-hermes.image-build",
    at: "2026-07-18T00:00:00.000Z",
    meminfo: parseMeminfo(MEMINFO_FIXTURE),
    load: { load1: 3.5, load5: 2.1, load15: 1.0 },
    cgroup: {
      currentBytes: 9 * 1024 ** 3,
      peakBytes: 12 * 1024 ** 3,
      limitBytes: null,
      events: { oom: 0, oomKill: 0 },
    },
    memoryPressure: { someAvg10: 12.5, someAvg60: 4.2, fullAvg10: 1.1, fullAvg60: 0.3 },
    ioPressure: { someAvg10: 0.0, someAvg60: 0.0, fullAvg10: 0.0, fullAvg60: 0.0 },
    topProcesses: [{ rssKb: 900000 }, { rssKb: 400000 }],
    containers: [
      {
        cpuPercent: 95.2,
        memBytes: 8 * 1024 ** 3,
        memLimitBytes: null,
      },
    ],
    dockerDisk: {
      imagesBytes: 20 * 1024 ** 3,
      containersBytes: 1024 ** 3,
      buildCacheBytes: 5 * 1024 ** 3,
    },
    disk: {
      freeBytes: 30 * 1024 ** 3,
      totalBytes: 80 * 1024 ** 3,
      inodesFree: 2_000_000,
      inodesTotal: 4_000_000,
    },
  };
}

describe("host measurement parsers (#7146)", () => {
  it("reads MemAvailable, Cached, SReclaimable, and swap from /proc/meminfo", () => {
    const sample = parseMeminfo(MEMINFO_FIXTURE);
    expect(sample).toEqual({
      memTotalKb: 16384000,
      memFreeKb: 204800,
      memAvailableKb: 12288000,
      cachedKb: 10240000,
      sReclaimableKb: 512000,
      swapTotalKb: 4194304,
      swapFreeKb: 4194304,
    });
  });

  it("keeps absent meminfo fields null instead of guessing", () => {
    const sample = parseMeminfo("MemTotal: 1024 kB\nBogus line\n");
    expect(sample.memTotalKb).toBe(1024);
    expect(sample.memAvailableKb).toBeNull();
    expect(sample.swapFreeKb).toBeNull();
  });

  it("parses load averages and rejects unrecognized loadavg shapes", () => {
    expect(parseLoadAverages("3.52 2.10 1.05 2/1234 99999\n")).toEqual({
      load1: 3.52,
      load5: 2.1,
      load15: 1.05,
    });
    expect(parseLoadAverages("not a loadavg")).toBeNull();
  });

  it("treats the cgroup 'max' sentinel as an absent limit", () => {
    expect(parseCgroupScalar("9663676416\n")).toBe(9663676416);
    expect(parseCgroupScalar("max\n")).toBeNull();
    expect(parseCgroupScalar("garbage")).toBeNull();
  });

  it("reads oom and oom_kill counters from memory.events", () => {
    const events = parseCgroupMemoryEvents("low 0\nhigh 44\nmax 12\noom 3\noom_kill 2\n");
    expect(events).toEqual({ oom: 3, oomKill: 2 });
    expect(parseCgroupMemoryEvents("")).toEqual({ oom: 0, oomKill: 0 });
  });

  it("reads some/full pressure stall averages from PSI files", () => {
    const psi = parsePressure(
      "some avg10=12.50 avg60=4.20 avg300=1.00 total=123456\nfull avg10=1.10 avg60=0.30 avg300=0.10 total=6543\n",
    );
    expect(psi).toEqual({ someAvg10: 12.5, someAvg60: 4.2, fullAvg10: 1.1, fullAvg60: 0.3 });
  });

  it("keeps only RSS ranks for top processes, sorted and bounded", () => {
    const ps = [
      "node             900000",
      "dockerd          400000",
      "sshd               8000",
      "vitest           700000",
      "tar              100000",
      "bash               4000",
      "gpg                2000",
    ].join("\n");
    const top = parseTopProcesses(ps);
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ rssKb: 900000 });
    expect(JSON.stringify(top)).not.toContain("node");
    expect(top.map((p) => p.rssKb)).toEqual([...top.map((p) => p.rssKb)].sort((a, b) => b - a));
  });

  it("converts Docker size strings across decimal and binary units", () => {
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("75.5kB")).toBe(75500);
    expect(parseDockerSize("1.5MiB")).toBe(1572864);
    expect(parseDockerSize("2GiB")).toBe(2147483648);
    expect(parseDockerSize("weird")).toBeNull();
  });

  it("parses docker stats without names and selects the largest consumers", () => {
    const stats = [
      JSON.stringify({ Name: "token-small", CPUPerc: "99%", MemUsage: "1GiB / 15.6GiB" }),
      JSON.stringify({ Name: "token-largest", CPUPerc: "1%", MemUsage: "9GiB / 15.6GiB" }),
      JSON.stringify({ Name: "token-middle", CPUPerc: "95.2%", MemUsage: "8GiB / 15.6GiB" }),
      "not json",
      JSON.stringify({ CPUPerc: "1%" }),
    ].join("\n");
    const rows = parseDockerStats(stats, 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.memBytes)).toEqual([9 * 1024 ** 3, 8 * 1024 ** 3]);
    expect(JSON.stringify(rows)).not.toContain("token-");
  });

  it("attributes docker disk use to images, containers, and build cache", () => {
    const df = [
      JSON.stringify({ Type: "Images", Size: "20GiB", Reclaimable: "4GiB" }),
      JSON.stringify({ Type: "Containers", Size: "1GiB", Reclaimable: "0B" }),
      JSON.stringify({ Type: "Build Cache", Size: "5GiB", Reclaimable: "5GiB" }),
    ].join("\n");
    expect(parseDockerSystemDf(df)).toEqual({
      imagesBytes: 20 * 1024 ** 3,
      containersBytes: 1024 ** 3,
      buildCacheBytes: 5 * 1024 ** 3,
    });
  });
});

describe("bounded secret-safe snapshot line (#7146)", () => {
  it("emits one prefixed line whose fields all come from the allowlisted shape", () => {
    const line = renderSnapshotLine(baseSnapshot());
    expect(line.startsWith(SNAPSHOT_LINE_PREFIX)).toBe(true);
    const payload = JSON.parse(line.slice(SNAPSHOT_LINE_PREFIX.length));
    expect(Object.keys(payload).sort()).toEqual([
      "at",
      "cgroup",
      "containers",
      "disk",
      "dockerDisk",
      "ioPressure",
      "load",
      "meminfo",
      "memoryPressure",
      "phase",
      "topProcesses",
      "v",
    ]);
    expect(payload.meminfo.memAvailableKb).toBe(12288000);
    expect(payload.cgroup.limitBytes).toBeNull();
    expect(payload.topProcesses[0]).toEqual({ rank: 1, rssKb: 900000 });
    expect(payload.containers[0]).toEqual({
      rank: 1,
      cpuPercent: 95.2,
      memBytes: 8 * 1024 ** 3,
      memLimitBytes: null,
    });
  });

  it("never emits fields outside the allowlist even when collectors misbehave", () => {
    const poisoned = baseSnapshot() as ResourceSnapshot & Record<string, unknown>;
    poisoned.leakedToken = "ghp_secret_value";
    (poisoned.meminfo as unknown as Record<string, unknown>).AWS_SECRET_ACCESS_KEY = "leak";
    (poisoned.topProcesses[0] as unknown as Record<string, unknown>).comm = "ghp_process_secret";
    (poisoned.containers[0] as unknown as Record<string, unknown>).name = "ghp_container_secret";
    const line = renderSnapshotLine(poisoned);
    expect(line).not.toContain("leak");
    expect(line).not.toContain("ghp_secret_value");
    expect(line).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(line).not.toContain("ghp_process_secret");
    expect(line).not.toContain("ghp_container_secret");
  });

  it("stays within the line bound by limiting ranked lists before rendering", () => {
    const bloated = baseSnapshot();
    bloated.topProcesses = Array.from({ length: 500 }, (_, i) => ({
      rssKb: i,
    }));
    bloated.containers = Array.from({ length: 500 }, (_, i) => ({
      cpuPercent: 1,
      memBytes: 1,
      memLimitBytes: 1,
    }));
    const line = renderSnapshotLine(bloated);
    expect(line.length).toBeLessThanOrEqual(SNAPSHOT_LINE_MAX_LENGTH);
    const payload = JSON.parse(line.slice(SNAPSHOT_LINE_PREFIX.length));
    expect(payload.meminfo.memAvailableKb).toBe(12288000);
    expect(payload.topProcesses).toHaveLength(5);
    expect(payload.containers).toHaveLength(5);
  });

  it("rejects phase labels that could inject argv options", () => {
    expect(assertPhaseLabel("rebuild-hermes.image-build")).toBe("rebuild-hermes.image-build");
    for (const bad of [undefined, "", "-oProxyCommand=x", "a b", "a$(x)", "a".repeat(80)]) {
      expect(() => assertPhaseLabel(bad)).toThrow(/phase label/);
    }
  });

  it("accepts only a bounded canonical UTC timestamp", () => {
    expect(assertCanonicalTimestamp("2026-07-18T00:00:00.000Z")).toBe("2026-07-18T00:00:00.000Z");
    for (const bad of [
      undefined,
      "",
      "2026-07-18",
      "2026-07-18T00:00:00Z",
      "2026-02-31T00:00:00.000Z",
      `2026-07-18T00:00:00.000Z${"ghp_secret".repeat(500)}`,
    ]) {
      expect(() => assertCanonicalTimestamp(bad)).toThrow(/timestamp/);
    }
  });
});

describe("terminal failure classification (#7146)", () => {
  it("round-trips a strict numeric/boolean phase baseline", () => {
    const line = renderBaselineLine({
      phase: "rebuild-hermes.image-build",
      at: "2026-07-18T00:00:00.000Z",
      cgroupOomKills: 3,
      kernelOomKillCount: 2,
      containerOomKilled: false,
    });
    expect(line.startsWith(BASELINE_LINE_PREFIX)).toBe(true);
    expect(parseBaselineLine(line)).toEqual({
      phase: "rebuild-hermes.image-build",
      at: "2026-07-18T00:00:00.000Z",
      cgroupOomKills: 3,
      kernelOomKillCount: 2,
      containerOomKilled: false,
    });
    expect(() =>
      parseBaselineLine(
        `${BASELINE_LINE_PREFIX}{"v":1,"phase":"unit-test","at":"2026-07-18T00:00:00.000Z","cgroupOomKills":0,"kernelOomKillCount":0,"containerOomKilled":false,"token":"ghp_secret"}`,
      ),
    ).toThrow(/shape/);
  });

  it("counts explicit kernel OOM-kill records for phase deltas", () => {
    expect(
      countKernelOomKills(
        "old line\nOut of memory: Killed process 42 (node)\nOut of memory: Killed process 99 (docker)\n",
      ),
    ).toBe(2);
  });

  it("never classifies low raw MemFree alone as OOM", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      memFreeKb: 1024,
      memAvailableKb: 8_000_000,
    });
    expect(classified.classification).toBe("unknown");
    expect(classified.reason).toContain("MemFree");
  });

  it("classifies a harness-reported assertion as assertion", () => {
    const classified = classifyFailure({ ...baseEvidence(), testOutcome: "assertion" });
    expect(classified.classification).toBe("assertion");
  });

  it("keeps an assertion deterministic even under background memory pressure", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      testOutcome: "assertion",
      memFreeKb: 1024,
    });
    expect(classified.classification).toBe("assertion");
  });

  it("classifies a container OOM kill from Docker evidence", () => {
    const classified = classifyFailure({ ...baseEvidence(), containerOomKilledAfter: true });
    expect(classified.classification).toBe("container-oom");
  });

  it("classifies a phase-local cgroup oom_kill delta as process OOM", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      cgroupOomKillsBefore: 3,
      cgroupOomKillsAfter: 5,
    });
    expect(classified.classification).toBe("process-oom");
    expect(classified.reason).toContain("2");
  });

  it("classifies a phase-local kernel OOM record delta as process OOM", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      kernelOomKillCountBefore: 4,
      kernelOomKillCountAfter: 5,
    });
    expect(classified.classification).toBe("process-oom");
  });

  it("does not attribute OOM evidence that predates the failing phase", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      cgroupOomKillsBefore: 3,
      cgroupOomKillsAfter: 3,
      kernelOomKillCountBefore: 2,
      kernelOomKillCountAfter: 2,
      containerOomKilledBefore: true,
      containerOomKilledAfter: true,
    });
    expect(classified.classification).toBe("unknown");
  });

  it("selects the last phase baseline before an OOM instead of cleanup sampled after it", () => {
    const initial = {
      phase: "workflow",
      at: "2026-07-18T00:00:00.000Z",
      cgroupOomKills: 3,
      kernelOomKillCount: 1,
      containerOomKilled: false,
    };
    const failingPhase = {
      ...initial,
      phase: "rebuild-hermes.phase-6",
      at: "2026-07-18T00:01:00.000Z",
    };
    const cleanup = {
      ...initial,
      phase: "rebuild-hermes.cleanup",
      at: "2026-07-18T00:02:00.000Z",
      cgroupOomKills: 4,
    };
    const current = { ...cleanup, phase: "workflow", at: "2026-07-18T00:03:00.000Z" };
    const currentWithoutOom = {
      ...initial,
      at: "2026-07-18T00:03:00.000Z",
    };

    expect(selectFailureBaseline(initial, [failingPhase, cleanup], current)).toEqual(failingPhase);
    expect(selectFailureBaseline(initial, [failingPhase], currentWithoutOom)).toEqual(initial);
    expect(() =>
      selectFailureBaseline(initial, [{ ...failingPhase, cgroupOomKills: 2 }], current),
    ).toThrow("not monotonic");
  });

  it("classifies exhausted workspace space or inodes as disk pressure", () => {
    expect(
      classifyFailure({ ...baseEvidence(), diskFreeBytes: MIN_DISK_FREE_BYTES - 1 }).classification,
    ).toBe("disk-pressure");
    expect(
      classifyFailure({ ...baseEvidence(), inodesFree: MIN_INODES_FREE - 1 }).classification,
    ).toBe("disk-pressure");
  });

  it("classifies a harness timeout without resource evidence as timeout", () => {
    const classified = classifyFailure({ ...baseEvidence(), testOutcome: "timeout" });
    expect(classified.classification).toBe("timeout");
  });

  it("prefers positive OOM evidence over a timeout it likely caused", () => {
    const classified = classifyFailure({
      ...baseEvidence(),
      testOutcome: "timeout",
      cgroupOomKillsAfter: 1,
    });
    expect(classified.classification).toBe("process-oom");
  });

  it("classifies an ambiguous failure as unknown", () => {
    expect(classifyFailure(baseEvidence()).classification).toBe("unknown");
  });

  it("renders a machine-readable classification line", () => {
    const line = renderClassificationLine({ classification: "disk-pressure", reason: "floor" });
    expect(line.startsWith(CLASSIFICATION_LINE_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(CLASSIFICATION_LINE_PREFIX.length))).toEqual({
      v: 1,
      classification: "disk-pressure",
      reason: "floor",
    });
  });

  it("strictly parses one bounded terminal classification", () => {
    const line = renderClassificationLine({ classification: "assertion", reason: "test failed" });
    expect(parseClassificationLine(line)).toEqual({
      classification: "assertion",
      reason: "test failed",
    });
    expect(() => parseClassificationLine(`${line.slice(0, -1)},"token":"ghp_secret"}`)).toThrow(
      "unsupported shape",
    );
    expect(() =>
      renderClassificationLine({ classification: "unknown", reason: "secret\nsecond line" }),
    ).toThrow("bounded printable ASCII");
  });
});

describe("runner-loss signature and retry policy (#7146)", () => {
  it("requires a positive loss signature, not just a failed job", () => {
    expect(
      detectRunnerLoss({
        terminalClassificationPresent: false,
        jobConclusion: "failure",
        runnerLostMarkerCount: 0,
      }),
    ).toBe(false);
  });

  it("does not treat cancellation alone as runner loss", () => {
    expect(
      detectRunnerLoss({
        terminalClassificationPresent: false,
        jobConclusion: "cancelled",
        runnerLostMarkerCount: 0,
      }),
    ).toBe(false);
  });

  it("detects loss from a positive trusted marker before classification", () => {
    expect(
      detectRunnerLoss({
        terminalClassificationPresent: false,
        jobConclusion: "failure",
        runnerLostMarkerCount: 1,
      }),
    ).toBe(true);
  });

  it("rejects malformed runner-loss marker counts", () => {
    expect(() =>
      detectRunnerLoss({
        terminalClassificationPresent: false,
        jobConclusion: "failure",
        runnerLostMarkerCount: -1,
      }),
    ).toThrow(/non-negative safe integer/u);
  });

  it("never treats an attempt that produced a terminal classification as loss", () => {
    expect(
      detectRunnerLoss({
        terminalClassificationPresent: true,
        jobConclusion: "cancelled",
        runnerLostMarkerCount: 3,
      }),
    ).toBe(false);
  });

  it("gives an ordinary assertion zero automatic retries", () => {
    const decision = decideRetry({ runnerLoss: false, classification: "assertion", attempt: 1 });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("assertion");
  });

  it("never retries classified OOM, disk-pressure, timeout, or unknown failures", () => {
    for (const classification of [
      "process-oom",
      "container-oom",
      "disk-pressure",
      "timeout",
      "unknown",
    ] as const) {
      expect(decideRetry({ runnerLoss: false, classification, attempt: 1 }).retry).toBe(false);
    }
  });

  it("fails closed when runner-loss evidence contradicts a terminal classification", () => {
    for (const classification of [
      "assertion",
      "timeout",
      "process-oom",
      "container-oom",
      "disk-pressure",
      "unknown",
    ] as const) {
      const decision = decideRetry({ runnerLoss: true, classification, attempt: 1 });
      expect(decision.retry).toBe(false);
      expect(decision.reason).toContain("terminal");
    }
  });

  it("permits exactly one retry for a confirmed runner loss and links the attempts", () => {
    const first = decideRetry({ runnerLoss: true, classification: null, attempt: 1 });
    expect(first.retry).toBe(true);
    expect(first.reason).toContain("linking both attempts");
    const second = decideRetry({ runnerLoss: true, classification: null, attempt: 2 });
    expect(second.retry).toBe(false);
    expect(second.reason).toContain("single permitted");
  });

  it("rejects a non-positive attempt number", () => {
    expect(() => decideRetry({ runnerLoss: true, classification: null, attempt: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("runner-pressure CLI fail-closed entrypoint (#7146)", () => {
  it("emits a bounded snapshot line even on hosts without cgroup or Docker", () => {
    const result = runHelper(["snapshot"], { E2E_PHASE: "unit-test-phase" });
    expect(result.status).toBe(0);
    const line = result.stdout.split("\n").find((l) => l.startsWith(SNAPSHOT_LINE_PREFIX));
    expect(line).toBeDefined();
    const payload = JSON.parse((line as string).slice(SNAPSHOT_LINE_PREFIX.length));
    expect(payload.phase).toBe("unit-test-phase");
    expect((line as string).length).toBeLessThanOrEqual(SNAPSHOT_LINE_MAX_LENGTH);
  }, 90_000);

  it("emits a strict pre-phase baseline through the real CLI", () => {
    const result = runHelper(["baseline"], {
      DOCKER_OOM_CONTAINER: "",
      E2E_PHASE: "unit-test",
    });
    expect(result.status).toBe(0);
    expect(parseBaselineLine(result.stdout)).toEqual({
      phase: "unit-test",
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      cgroupOomKills: expect.any(Number),
      kernelOomKillCount: expect.any(Number),
      containerOomKilled: false,
    });
  }, 90_000);

  it("initializes private evidence files before the live test", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-evidence-"));
    const baselinePath = path.join(directory, "baseline.jsonl");
    const phaseBaselinesPath = path.join(directory, "phase-baselines.jsonl");
    const classificationPath = path.join(directory, "classification.jsonl");
    try {
      const result = runHelper(["initialize-evidence"], {
        DOCKER_OOM_CONTAINER: "",
        E2E_PHASE: "unit-test",
        E2E_RESOURCE_BASELINE_FILE: baselinePath,
        E2E_RESOURCE_PHASE_BASELINES_FILE: phaseBaselinesPath,
        E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
      });
      expect(result.status).toBe(0);
      expect(parseBaselineLine(fs.readFileSync(baselinePath, "utf8")).phase).toBe("unit-test");
      expect(fs.readFileSync(phaseBaselinesPath, "utf8")).toBe("");
      expect(fs.readFileSync(classificationPath, "utf8")).toBe("");
      for (const file of [baselinePath, phaseBaselinesPath, classificationPath]) {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.each([
    "assertion",
    "timeout",
  ] as const)("classifies a trusted harness %s artifact through the real CLI", (outcome) => {
    withEvidenceFiles(outcome, (baselinePath, outcomePath) => {
      const classificationPath = path.join(path.dirname(baselinePath), "classification.jsonl");
      fs.writeFileSync(classificationPath, "", { mode: 0o600 });
      const result = runHelper(["classify"], {
        E2E_RESOURCE_BASELINE_FILE: baselinePath,
        E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
        E2E_TEST_OUTCOME_FILE: outcomePath,
      });
      expect(result.status).toBe(0);
      const line = result.stdout.split("\n").find((l) => l.startsWith(CLASSIFICATION_LINE_PREFIX));
      expect(line).toBeDefined();
      expect(
        JSON.parse((line as string).slice(CLASSIFICATION_LINE_PREFIX.length)).classification,
      ).toBe(outcome);
      expect(fs.readFileSync(classificationPath, "utf8").trim()).toBe(line);
    });
  }, 90_000);

  it.each([
    "symlink",
    "hardlink",
  ] as const)("rejects %s-substituted baseline, phase, and classification evidence", (linkKind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-linked-evidence-"));
    const baselinePath = path.join(directory, "baseline.jsonl");
    const phaseBaselinesPath = path.join(directory, "phase-baselines.jsonl");
    const classificationPath = path.join(directory, "classification.jsonl");
    const outcomePath = path.join(directory, LIVE_TEST_OUTCOME_FILE);
    const canonicalBaseline = `${renderBaselineLine({
      phase: "unit-test",
      at: "2026-07-18T00:00:00.000Z",
      cgroupOomKills: 0,
      kernelOomKillCount: 0,
      containerOomKilled: false,
    })}\n`;
    const canonicalClassification = `${renderClassificationLine({
      classification: "assertion",
      reason: "protected target",
    })}\n`;
    const link = LINK_CREATORS[linkKind];
    const environment = {
      DOCKER_OOM_CONTAINER: "",
      E2E_PHASE: "unit-test",
      E2E_RESOURCE_BASELINE_FILE: baselinePath,
      E2E_RESOURCE_PHASE_BASELINES_FILE: phaseBaselinesPath,
      E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
      E2E_TEST_OUTCOME_FILE: outcomePath,
    };
    try {
      fs.writeFileSync(outcomePath, renderLiveTestOutcome("assertion"), { mode: 0o600 });

      const baselineTarget = path.join(directory, "baseline-target.jsonl");
      fs.writeFileSync(baselineTarget, canonicalBaseline, { mode: 0o600 });
      link(baselineTarget, baselinePath);
      fs.writeFileSync(phaseBaselinesPath, "", { mode: 0o600 });
      fs.writeFileSync(classificationPath, "", { mode: 0o600 });
      expect(runHelper(["classify"], environment).status).not.toBe(0);
      expect(fs.readFileSync(baselineTarget, "utf8")).toBe(canonicalBaseline);

      fs.unlinkSync(baselinePath);
      fs.writeFileSync(baselinePath, canonicalBaseline, { mode: 0o600 });
      fs.unlinkSync(phaseBaselinesPath);
      const phaseTarget = path.join(directory, "phase-target.jsonl");
      fs.writeFileSync(phaseTarget, "", { mode: 0o600 });
      link(phaseTarget, phaseBaselinesPath);
      expect(runHelper(["classify"], environment).status).not.toBe(0);
      expect(fs.readFileSync(phaseTarget, "utf8")).toBe("");

      fs.unlinkSync(phaseBaselinesPath);
      fs.writeFileSync(phaseBaselinesPath, "", { mode: 0o600 });
      fs.unlinkSync(classificationPath);
      const classificationTarget = path.join(directory, "classification-target.jsonl");
      fs.writeFileSync(classificationTarget, canonicalClassification, { mode: 0o600 });
      link(classificationTarget, classificationPath);
      expect(runHelper(["initialize-evidence"], environment).status).not.toBe(0);
      expect(runHelper(["validate-classification"], environment).status).not.toBe(0);
      expect(fs.readFileSync(classificationTarget, "utf8")).toBe(canonicalClassification);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("rejects missing or malformed pre-phase evidence before classification", () => {
    const missing = runHelper(["classify"], {});
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("E2E_RESOURCE_BASELINE_FILE");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-pressure-bad-"));
    const baselinePath = path.join(directory, "baseline.jsonl");
    try {
      fs.writeFileSync(baselinePath, `${BASELINE_LINE_PREFIX}{"v":1,"token":"ghp_secret"}\n`);
      const malformed = runHelper(["classify"], {
        E2E_RESOURCE_BASELINE_FILE: baselinePath,
      });
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr).toContain("unsupported shape");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("consumes exactly one canonical terminal classification artifact", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-classification-"));
    const classificationPath = path.join(directory, "classification.jsonl");
    try {
      fs.writeFileSync(
        classificationPath,
        `${renderClassificationLine({ classification: "timeout", reason: "phase timed out" })}\n`,
      );
      const valid = runHelper(["validate-classification"], {
        E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
      });
      expect(valid.status).toBe(0);
      expect(valid.stdout.trim()).toBe("timeout");

      fs.writeFileSync(classificationPath, `${CLASSIFICATION_LINE_PREFIX}{"v":1}\n`);
      const malformed = runHelper(["validate-classification"], {
        E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
      });
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr).toContain("unsupported shape");

      fs.writeFileSync(
        classificationPath,
        `${renderClassificationLine({ classification: "timeout", reason: "first" })}\n${renderClassificationLine({ classification: "unknown", reason: "second" })}\n`,
      );
      const duplicate = runHelper(["validate-classification"], {
        E2E_TERMINAL_CLASSIFICATION_FILE: classificationPath,
      });
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("exactly one line");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("prints a no-retry decision for an assertion and a retry for first runner loss", () => {
    const assertion = runHelper(["decide-retry"], {
      E2E_RUNNER_LOSS: "false",
      E2E_CLASSIFICATION: "assertion",
      E2E_ATTEMPT: "1",
    });
    expect(assertion.status).toBe(0);
    expect(JSON.parse(assertion.stdout.trim()).retry).toBe(false);

    const contradiction = runHelper(["decide-retry"], {
      E2E_RUNNER_LOSS: "true",
      E2E_CLASSIFICATION: "assertion",
      E2E_ATTEMPT: "1",
    });
    expect(contradiction.status).toBe(0);
    expect(JSON.parse(contradiction.stdout.trim()).retry).toBe(false);

    const loss = runHelper(["decide-retry"], {
      E2E_RUNNER_LOSS: "true",
      E2E_CLASSIFICATION: "",
      E2E_ATTEMPT: "1",
    });
    expect(loss.status).toBe(0);
    expect(JSON.parse(loss.stdout.trim()).retry).toBe(true);
  }, 90_000);

  it("fails closed on a missing or unsupported subcommand", () => {
    for (const args of [[], ["snapshotx"], ["run"]]) {
      const result = runHelper(args, {});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
  }, 90_000);
});
