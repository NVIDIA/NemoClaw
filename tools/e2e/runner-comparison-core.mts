// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export const RUNNER_COMPARISON_LEDGER_FILE = "runner-comparison.jsonl";
export const RUNNER_COMPARISON_SUMMARY_FILE = "runner-comparison-summary.json";
export const RUNNER_COMPARISON_LEDGER_MAX_BYTES = 8192;
export const RUNNER_COMPARISON_SUMMARY_MAX_BYTES = 8192;

const SAMPLE_LINE_MAX_BYTES = 4096;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface RunnerComparisonIdentity {
  target: string;
  shard: string | null;
}

export interface RunnerComparisonSample extends RunnerComparisonIdentity {
  v: 1;
  at: string;
  cpu: {
    logicalCpuCount: number;
    idleTicks: number;
    totalTicks: number;
  } | null;
  memory: {
    totalKb: number | null;
    availableKb: number | null;
    rootCgroupPeakBytes: number | null;
  };
  workspace: {
    totalBytes: number | null;
    freeBytes: number | null;
  };
}

export interface RunnerComparisonSummary extends RunnerComparisonIdentity {
  v: 1;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sampleCount: number;
  cpu: {
    logicalCpuCount: number | null;
    averageBusyPercent: number | null;
    averageBusyLogicalCpus: number | null;
  };
  memory: {
    totalKb: number | null;
    startAvailableKb: number | null;
    endAvailableKb: number | null;
    maximumEndpointUsedKb: number | null;
    rootCgroupPeakBytes: number | null;
  };
  workspace: {
    totalBytes: number | null;
    startFreeBytes: number | null;
    endFreeBytes: number | null;
    netGrowthBytes: number | null;
    minimumEndpointFreeBytes: number | null;
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} has an unsupported shape`);
  }
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  return value === null ? null : nonNegativeInteger(value, field);
}

function identityLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded alphanumeric label`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    throw new Error("sample.at must be a canonical UTC timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("sample.at must be a canonical UTC timestamp");
  }
  return value;
}

function parseCpu(value: unknown): RunnerComparisonSample["cpu"] {
  if (value === null) return null;
  const cpu = record(value, "sample.cpu");
  exactKeys(cpu, ["logicalCpuCount", "idleTicks", "totalTicks"], "sample.cpu");
  const parsed = {
    logicalCpuCount: nonNegativeInteger(cpu.logicalCpuCount, "sample.cpu.logicalCpuCount"),
    idleTicks: nonNegativeInteger(cpu.idleTicks, "sample.cpu.idleTicks"),
    totalTicks: nonNegativeInteger(cpu.totalTicks, "sample.cpu.totalTicks"),
  };
  if (parsed.logicalCpuCount < 1) throw new Error("sample.cpu.logicalCpuCount must be positive");
  if (parsed.idleTicks > parsed.totalTicks) {
    throw new Error("sample.cpu.idleTicks cannot exceed totalTicks");
  }
  return parsed;
}

function parseMemory(value: unknown): RunnerComparisonSample["memory"] {
  const memory = record(value, "sample.memory");
  exactKeys(memory, ["totalKb", "availableKb", "rootCgroupPeakBytes"], "sample.memory");
  const parsed = {
    totalKb: nullableNonNegativeInteger(memory.totalKb, "sample.memory.totalKb"),
    availableKb: nullableNonNegativeInteger(memory.availableKb, "sample.memory.availableKb"),
    rootCgroupPeakBytes: nullableNonNegativeInteger(
      memory.rootCgroupPeakBytes,
      "sample.memory.rootCgroupPeakBytes",
    ),
  };
  if (
    parsed.totalKb !== null &&
    parsed.availableKb !== null &&
    parsed.availableKb > parsed.totalKb
  ) {
    throw new Error("sample.memory.availableKb cannot exceed totalKb");
  }
  return parsed;
}

function parseWorkspace(value: unknown): RunnerComparisonSample["workspace"] {
  const workspace = record(value, "sample.workspace");
  exactKeys(workspace, ["totalBytes", "freeBytes"], "sample.workspace");
  const parsed = {
    totalBytes: nullableNonNegativeInteger(workspace.totalBytes, "sample.workspace.totalBytes"),
    freeBytes: nullableNonNegativeInteger(workspace.freeBytes, "sample.workspace.freeBytes"),
  };
  if (
    parsed.totalBytes !== null &&
    parsed.freeBytes !== null &&
    parsed.freeBytes > parsed.totalBytes
  ) {
    throw new Error("sample.workspace.freeBytes cannot exceed totalBytes");
  }
  return parsed;
}

export function parseRunnerComparisonSample(line: string): RunnerComparisonSample {
  if (Buffer.byteLength(line) > SAMPLE_LINE_MAX_BYTES) {
    throw new Error("runner comparison sample exceeds its size bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("runner comparison sample must be valid JSON");
  }
  const sample = record(parsed, "sample");
  exactKeys(sample, ["v", "at", "target", "shard", "cpu", "memory", "workspace"], "sample");
  if (sample.v !== 1) throw new Error("sample.v must be 1");
  const target = identityLabel(sample.target, "sample.target");
  const shard = sample.shard === null ? null : identityLabel(sample.shard, "sample.shard");
  const canonical: RunnerComparisonSample = {
    v: 1,
    at: canonicalTimestamp(sample.at),
    target,
    shard,
    cpu: parseCpu(sample.cpu),
    memory: parseMemory(sample.memory),
    workspace: parseWorkspace(sample.workspace),
  };
  if (JSON.stringify(canonical) !== line) {
    throw new Error("runner comparison sample must use the canonical JSON encoding");
  }
  return canonical;
}

export function renderRunnerComparisonSample(sample: RunnerComparisonSample): string {
  return JSON.stringify(parseRunnerComparisonSample(JSON.stringify(sample)));
}

function sameIdentity(left: RunnerComparisonIdentity, right: RunnerComparisonIdentity): boolean {
  return left.target === right.target && left.shard === right.shard;
}

export function parseRunnerComparisonLedger(contents: string): RunnerComparisonSample[] {
  if (Buffer.byteLength(contents) > RUNNER_COMPARISON_LEDGER_MAX_BYTES) {
    throw new Error("runner comparison ledger exceeds its size bound");
  }
  const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 1 || lines.length > 2) {
    throw new Error("runner comparison ledger must contain one or two samples");
  }
  if (contents !== `${lines.join("\n")}\n`) {
    throw new Error("runner comparison ledger must use the canonical JSONL encoding");
  }
  const samples = lines.map(parseRunnerComparisonSample);
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (!sameIdentity(previous, current)) {
      throw new Error("runner comparison sample identity changed during the job");
    }
    if (Date.parse(current.at) <= Date.parse(previous.at)) {
      throw new Error("runner comparison timestamps must increase");
    }
    if (
      previous.cpu !== null &&
      current.cpu !== null &&
      (previous.cpu.logicalCpuCount !== current.cpu.logicalCpuCount ||
        current.cpu.totalTicks < previous.cpu.totalTicks ||
        current.cpu.idleTicks < previous.cpu.idleTicks)
    ) {
      throw new Error("runner comparison CPU counters must be monotonic and use one capacity");
    }
  }
  return samples;
}

function rounded(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function commonValue(left: number | null, right: number | null): number | null {
  return left !== null && right !== null && left === right ? left : null;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function minimum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

export function summarizeRunnerComparison(
  samples: readonly RunnerComparisonSample[],
): RunnerComparisonSummary {
  if (samples.length < 2) throw new Error("at least two runner comparison samples are required");
  const start = samples[0]!;
  const finish = samples[samples.length - 1]!;
  if (!sameIdentity(start, finish)) {
    throw new Error("runner comparison sample identity changed during the job");
  }
  const durationMs = Date.parse(finish.at) - Date.parse(start.at);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("runner comparison duration must be positive");
  }

  let logicalCpuCount: number | null = null;
  let averageBusyPercent: number | null = null;
  let averageBusyLogicalCpus: number | null = null;
  if (start.cpu !== null && finish.cpu !== null) {
    const totalDelta = finish.cpu.totalTicks - start.cpu.totalTicks;
    const idleDelta = finish.cpu.idleTicks - start.cpu.idleTicks;
    if (
      start.cpu.logicalCpuCount === finish.cpu.logicalCpuCount &&
      totalDelta > 0 &&
      idleDelta >= 0 &&
      idleDelta <= totalDelta
    ) {
      logicalCpuCount = start.cpu.logicalCpuCount;
      const busyFraction = (totalDelta - idleDelta) / totalDelta;
      averageBusyPercent = rounded(busyFraction * 100, 2);
      averageBusyLogicalCpus = rounded(busyFraction * logicalCpuCount, 3);
    }
  }

  const memoryTotalKb = commonValue(start.memory.totalKb, finish.memory.totalKb);
  const endpointMemoryUsed = [start.memory.availableKb, finish.memory.availableKb].map(
    (available) =>
      memoryTotalKb !== null && available !== null ? memoryTotalKb - available : null,
  );
  const workspaceTotalBytes = commonValue(start.workspace.totalBytes, finish.workspace.totalBytes);
  const netGrowthBytes =
    start.workspace.freeBytes !== null && finish.workspace.freeBytes !== null
      ? start.workspace.freeBytes - finish.workspace.freeBytes
      : null;

  return {
    v: 1,
    target: start.target,
    shard: start.shard,
    startedAt: start.at,
    finishedAt: finish.at,
    durationMs,
    sampleCount: samples.length,
    cpu: { logicalCpuCount, averageBusyPercent, averageBusyLogicalCpus },
    memory: {
      totalKb: memoryTotalKb,
      startAvailableKb: start.memory.availableKb,
      endAvailableKb: finish.memory.availableKb,
      maximumEndpointUsedKb: maximum(endpointMemoryUsed),
      rootCgroupPeakBytes: maximum([
        start.memory.rootCgroupPeakBytes,
        finish.memory.rootCgroupPeakBytes,
      ]),
    },
    workspace: {
      totalBytes: workspaceTotalBytes,
      startFreeBytes: start.workspace.freeBytes,
      endFreeBytes: finish.workspace.freeBytes,
      netGrowthBytes,
      minimumEndpointFreeBytes: minimum([start.workspace.freeBytes, finish.workspace.freeBytes]),
    },
  };
}

export function renderRunnerComparisonSummary(summary: RunnerComparisonSummary): string {
  const serialized = JSON.stringify(summary, null, 2);
  if (Buffer.byteLength(serialized) > RUNNER_COMPARISON_SUMMARY_MAX_BYTES) {
    throw new Error("runner comparison summary exceeds its size bound");
  }
  return `${serialized}\n`;
}

export function parseCpuStat(text: string): RunnerComparisonSample["cpu"] {
  const lines = text.split("\n");
  const aggregate = lines.find((line) => /^cpu\s+/u.test(line));
  const logicalCpuCount = lines.filter((line) => /^cpu\d+\s+/u.test(line)).length;
  if (!aggregate || logicalCpuCount < 1) return null;
  const values = aggregate.trim().split(/\s+/u).slice(1, 9);
  if (values.length !== 8 || values.some((value) => !/^\d+$/u.test(value))) return null;
  const counters = values.map(Number);
  if (counters.some((value) => !Number.isSafeInteger(value))) return null;
  const idleTicks = counters[3]! + counters[4]!;
  const totalTicks = counters.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(idleTicks) || !Number.isSafeInteger(totalTicks)) return null;
  return { logicalCpuCount, idleTicks, totalTicks };
}

export function parseComparisonMeminfo(text: string): {
  totalKb: number | null;
  availableKb: number | null;
} {
  const read = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, "mu").exec(text);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  return { totalKb: read("MemTotal"), availableKb: read("MemAvailable") };
}

function parseScalar(text: string | null): number | null {
  if (text === null || !/^\d+\s*$/u.test(text)) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : null;
}

function checkedProduct(left: number | bigint, right: number | bigint): number | null {
  const value = Number(left) * Number(right);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface RunnerComparisonSources {
  now: () => Date;
  readText: (file: string) => string | null;
  statfs: (directory: string) => {
    bavail: number | bigint;
    blocks: number | bigint;
    bsize: number | bigint;
  };
}

const defaultSources: RunnerComparisonSources = {
  now: () => new Date(),
  readText: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  statfs: (directory) => fs.statfsSync(directory),
};

export function collectRunnerComparisonSample(
  identity: RunnerComparisonIdentity,
  workspace = process.cwd(),
  sources: RunnerComparisonSources = defaultSources,
): RunnerComparisonSample {
  const target = identityLabel(identity.target, "sample.target");
  const shard = identity.shard === null ? null : identityLabel(identity.shard, "sample.shard");
  const meminfo = parseComparisonMeminfo(sources.readText("/proc/meminfo") ?? "");
  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  try {
    const stat = sources.statfs(workspace);
    totalBytes = checkedProduct(stat.blocks, stat.bsize);
    freeBytes = checkedProduct(stat.bavail, stat.bsize);
  } catch {
    // Missing workspace telemetry is represented by null fields.
  }
  return {
    v: 1,
    at: canonicalTimestamp(sources.now().toISOString()),
    target,
    shard,
    cpu: parseCpuStat(sources.readText("/proc/stat") ?? ""),
    memory: {
      totalKb: meminfo.totalKb,
      availableKb: meminfo.availableKb,
      rootCgroupPeakBytes: parseScalar(sources.readText("/sys/fs/cgroup/memory.peak")),
    },
    workspace: { totalBytes, freeBytes },
  };
}
