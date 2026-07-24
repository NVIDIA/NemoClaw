// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical runner-comparison sample and ledger schema. */

import { PROCESS_CLASSES, type ProcessClass } from "./runner-pressure-core.mts";

export const RUNNER_COMPARISON_LEDGER_FILE = "runner-comparison.jsonl";
export const RUNNER_COMPARISON_SUMMARY_FILE = "runner-comparison-summary.json";
// The 60-second cadence and semantic boundaries must outlast the longest
// instrumented 120-minute job while reserving one finalization slot.
export const RUNNER_COMPARISON_MAX_SAMPLES = 256;
export const RUNNER_COMPARISON_LEDGER_MAX_BYTES = RUNNER_COMPARISON_MAX_SAMPLES * (4096 + 1);
export const RUNNER_COMPARISON_SUMMARY_MAX_BYTES = 8192;
export const RUNNER_COMPARISON_SAMPLE_LINE_PREFIX = "E2E_RUNNER_COMPARISON_SAMPLE ";

const SAMPLE_LINE_MAX_BYTES = 4096;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAMPLE_KINDS = ["initialize", "scenario-start", "phase", "periodic", "finalize"] as const;

export type RunnerComparisonSampleKind = (typeof SAMPLE_KINDS)[number];
export type RunnerComparisonProcessClass = ProcessClass;

export interface RunnerComparisonIdentity {
  target: string;
  shard: string | null;
}

/** Historical #7399 two-endpoint artifact schema. */
export interface RunnerComparisonSampleV1 extends RunnerComparisonIdentity {
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

export interface RunnerComparisonSample extends RunnerComparisonIdentity {
  v: 2;
  sequence: number;
  kind: RunnerComparisonSampleKind;
  phase: string | null;
  at: string;
  cpu: {
    logicalCpuCount: number;
    idleTicks: number;
    totalTicks: number;
  } | null;
  load: {
    oneMinute: number | null;
    fiveMinutes: number | null;
    fifteenMinutes: number | null;
  };
  memory: {
    totalKb: number | null;
    availableKb: number | null;
    cachedKb: number | null;
    sReclaimableKb: number | null;
    swapTotalKb: number | null;
    swapFreeKb: number | null;
    rootCgroupCurrentBytes: number | null;
    rootCgroupPeakBytes: number | null;
    rootCgroupLimitBytes: number | null;
    rootCgroupOom: number | null;
    rootCgroupOomKill: number | null;
  };
  pressure: {
    memoryFullAvg60: number | null;
    ioFullAvg60: number | null;
  };
  workspace: {
    totalBytes: number | null;
    freeBytes: number | null;
    inodesTotal: number | null;
    inodesFree: number | null;
  };
  docker: {
    imagesBytes: number | null;
    containersBytes: number | null;
    buildCacheBytes: number | null;
    maximumContainerMemoryBytes: number | null;
    maximumContainerCpuPercent: number | null;
  };
  largestProcess: {
    class: RunnerComparisonProcessClass;
    rssKb: number;
  } | null;
}

export type ParsedRunnerComparisonSample = RunnerComparisonSampleV1 | RunnerComparisonSample;

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

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : nonNegativeInteger(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number or null`);
  }
  return value;
}

function nullablePercentage(value: unknown, field: string): number | null {
  const parsed = nullableNumber(value, field);
  if (parsed !== null && parsed > 100) throw new Error(`${field} must not exceed 100`);
  return parsed;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded alphanumeric label`);
  }
  return value;
}

function nullableLabel(value: unknown, field: string): string | null {
  return value === null ? null : label(value, field);
}

function timestamp(value: unknown): string {
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

function parseLegacyMemory(value: unknown): RunnerComparisonSampleV1["memory"] {
  const memory = record(value, "sample.memory");
  exactKeys(memory, ["totalKb", "availableKb", "rootCgroupPeakBytes"], "sample.memory");
  const parsed = {
    totalKb: nullableInteger(memory.totalKb, "sample.memory.totalKb"),
    availableKb: nullableInteger(memory.availableKb, "sample.memory.availableKb"),
    rootCgroupPeakBytes: nullableInteger(
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

function parseLegacyWorkspace(value: unknown): RunnerComparisonSampleV1["workspace"] {
  const workspace = record(value, "sample.workspace");
  exactKeys(workspace, ["totalBytes", "freeBytes"], "sample.workspace");
  const parsed = {
    totalBytes: nullableInteger(workspace.totalBytes, "sample.workspace.totalBytes"),
    freeBytes: nullableInteger(workspace.freeBytes, "sample.workspace.freeBytes"),
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

function parseLoad(value: unknown): RunnerComparisonSample["load"] {
  const load = record(value, "sample.load");
  exactKeys(load, ["oneMinute", "fiveMinutes", "fifteenMinutes"], "sample.load");
  return {
    oneMinute: nullableNumber(load.oneMinute, "sample.load.oneMinute"),
    fiveMinutes: nullableNumber(load.fiveMinutes, "sample.load.fiveMinutes"),
    fifteenMinutes: nullableNumber(load.fifteenMinutes, "sample.load.fifteenMinutes"),
  };
}

function parseMemory(value: unknown): RunnerComparisonSample["memory"] {
  const memory = record(value, "sample.memory");
  exactKeys(
    memory,
    [
      "totalKb",
      "availableKb",
      "cachedKb",
      "sReclaimableKb",
      "swapTotalKb",
      "swapFreeKb",
      "rootCgroupCurrentBytes",
      "rootCgroupPeakBytes",
      "rootCgroupLimitBytes",
      "rootCgroupOom",
      "rootCgroupOomKill",
    ],
    "sample.memory",
  );
  const parsed: RunnerComparisonSample["memory"] = {
    totalKb: nullableInteger(memory.totalKb, "sample.memory.totalKb"),
    availableKb: nullableInteger(memory.availableKb, "sample.memory.availableKb"),
    cachedKb: nullableInteger(memory.cachedKb, "sample.memory.cachedKb"),
    sReclaimableKb: nullableInteger(memory.sReclaimableKb, "sample.memory.sReclaimableKb"),
    swapTotalKb: nullableInteger(memory.swapTotalKb, "sample.memory.swapTotalKb"),
    swapFreeKb: nullableInteger(memory.swapFreeKb, "sample.memory.swapFreeKb"),
    rootCgroupCurrentBytes: nullableInteger(
      memory.rootCgroupCurrentBytes,
      "sample.memory.rootCgroupCurrentBytes",
    ),
    rootCgroupPeakBytes: nullableInteger(
      memory.rootCgroupPeakBytes,
      "sample.memory.rootCgroupPeakBytes",
    ),
    rootCgroupLimitBytes: nullableInteger(
      memory.rootCgroupLimitBytes,
      "sample.memory.rootCgroupLimitBytes",
    ),
    rootCgroupOom: nullableInteger(memory.rootCgroupOom, "sample.memory.rootCgroupOom"),
    rootCgroupOomKill: nullableInteger(memory.rootCgroupOomKill, "sample.memory.rootCgroupOomKill"),
  };
  for (const [value, field] of [
    [parsed.availableKb, "availableKb"],
    [parsed.cachedKb, "cachedKb"],
    [parsed.sReclaimableKb, "sReclaimableKb"],
  ] as const) {
    if (parsed.totalKb !== null && value !== null && value > parsed.totalKb) {
      throw new Error(`sample.memory.${field} cannot exceed totalKb`);
    }
  }
  if ((parsed.swapTotalKb === null) !== (parsed.swapFreeKb === null)) {
    throw new Error("sample.memory swap totals must be present together");
  }
  if (
    parsed.swapTotalKb !== null &&
    parsed.swapFreeKb !== null &&
    parsed.swapFreeKb > parsed.swapTotalKb
  ) {
    throw new Error("sample.memory.swapFreeKb cannot exceed swapTotalKb");
  }
  if (
    parsed.rootCgroupCurrentBytes !== null &&
    parsed.rootCgroupPeakBytes !== null &&
    parsed.rootCgroupCurrentBytes > parsed.rootCgroupPeakBytes
  ) {
    throw new Error("sample.memory.rootCgroupCurrentBytes cannot exceed rootCgroupPeakBytes");
  }
  if ((parsed.rootCgroupOom === null) !== (parsed.rootCgroupOomKill === null)) {
    throw new Error("sample.memory cgroup OOM counters must be present together");
  }
  return parsed;
}

function parsePressure(value: unknown): RunnerComparisonSample["pressure"] {
  const pressure = record(value, "sample.pressure");
  exactKeys(pressure, ["memoryFullAvg60", "ioFullAvg60"], "sample.pressure");
  return {
    memoryFullAvg60: nullablePercentage(
      pressure.memoryFullAvg60,
      "sample.pressure.memoryFullAvg60",
    ),
    ioFullAvg60: nullablePercentage(pressure.ioFullAvg60, "sample.pressure.ioFullAvg60"),
  };
}

function parseWorkspace(value: unknown): RunnerComparisonSample["workspace"] {
  const workspace = record(value, "sample.workspace");
  exactKeys(
    workspace,
    ["totalBytes", "freeBytes", "inodesTotal", "inodesFree"],
    "sample.workspace",
  );
  const parsed = {
    totalBytes: nullableInteger(workspace.totalBytes, "sample.workspace.totalBytes"),
    freeBytes: nullableInteger(workspace.freeBytes, "sample.workspace.freeBytes"),
    inodesTotal: nullableInteger(workspace.inodesTotal, "sample.workspace.inodesTotal"),
    inodesFree: nullableInteger(workspace.inodesFree, "sample.workspace.inodesFree"),
  };
  if ((parsed.totalBytes === null) !== (parsed.freeBytes === null)) {
    throw new Error("sample.workspace byte totals must be present together");
  }
  if (
    parsed.totalBytes !== null &&
    parsed.freeBytes !== null &&
    parsed.freeBytes > parsed.totalBytes
  ) {
    throw new Error("sample.workspace.freeBytes cannot exceed totalBytes");
  }
  if ((parsed.inodesTotal === null) !== (parsed.inodesFree === null)) {
    throw new Error("sample.workspace inode totals must be present together");
  }
  if (
    parsed.inodesTotal !== null &&
    parsed.inodesFree !== null &&
    parsed.inodesFree > parsed.inodesTotal
  ) {
    throw new Error("sample.workspace.inodesFree cannot exceed inodesTotal");
  }
  return parsed;
}

function parseDocker(value: unknown): RunnerComparisonSample["docker"] {
  const docker = record(value, "sample.docker");
  exactKeys(
    docker,
    [
      "imagesBytes",
      "containersBytes",
      "buildCacheBytes",
      "maximumContainerMemoryBytes",
      "maximumContainerCpuPercent",
    ],
    "sample.docker",
  );
  return {
    imagesBytes: nullableInteger(docker.imagesBytes, "sample.docker.imagesBytes"),
    containersBytes: nullableInteger(docker.containersBytes, "sample.docker.containersBytes"),
    buildCacheBytes: nullableInteger(docker.buildCacheBytes, "sample.docker.buildCacheBytes"),
    maximumContainerMemoryBytes: nullableInteger(
      docker.maximumContainerMemoryBytes,
      "sample.docker.maximumContainerMemoryBytes",
    ),
    maximumContainerCpuPercent: nullableNumber(
      docker.maximumContainerCpuPercent,
      "sample.docker.maximumContainerCpuPercent",
    ),
  };
}

function parseLargestProcess(value: unknown): RunnerComparisonSample["largestProcess"] {
  if (value === null) return null;
  const process = record(value, "sample.largestProcess");
  exactKeys(process, ["class", "rssKb"], "sample.largestProcess");
  if (
    typeof process.class !== "string" ||
    !PROCESS_CLASSES.includes(process.class as RunnerComparisonProcessClass)
  ) {
    throw new Error("sample.largestProcess.class must be a supported fixed value");
  }
  return {
    class: process.class as RunnerComparisonProcessClass,
    rssKb: nonNegativeInteger(process.rssKb, "sample.largestProcess.rssKb"),
  };
}

function parseSampleObject(parsed: UnknownRecord, line: string): ParsedRunnerComparisonSample {
  if (parsed.v === 1) {
    exactKeys(parsed, ["v", "at", "target", "shard", "cpu", "memory", "workspace"], "sample");
    const sample: RunnerComparisonSampleV1 = {
      v: 1,
      at: timestamp(parsed.at),
      target: label(parsed.target, "sample.target"),
      shard: nullableLabel(parsed.shard, "sample.shard"),
      cpu: parseCpu(parsed.cpu),
      memory: parseLegacyMemory(parsed.memory),
      workspace: parseLegacyWorkspace(parsed.workspace),
    };
    if (JSON.stringify(sample) !== line) {
      throw new Error("runner comparison sample must use the canonical JSON encoding");
    }
    return sample;
  }

  exactKeys(
    parsed,
    [
      "v",
      "sequence",
      "kind",
      "phase",
      "at",
      "target",
      "shard",
      "cpu",
      "load",
      "memory",
      "pressure",
      "workspace",
      "docker",
      "largestProcess",
    ],
    "sample",
  );
  if (parsed.v !== 2) throw new Error("sample.v must be 1 or 2");
  if (
    typeof parsed.kind !== "string" ||
    !SAMPLE_KINDS.includes(parsed.kind as RunnerComparisonSampleKind)
  ) {
    throw new Error("sample.kind must be a supported fixed value");
  }
  const kind = parsed.kind as RunnerComparisonSampleKind;
  const phase = nullableLabel(parsed.phase, "sample.phase");
  if ((kind === "initialize" || kind === "finalize") && phase !== null) {
    throw new Error(`sample.phase must be null for ${kind} samples`);
  }
  if ((kind === "scenario-start" || kind === "phase" || kind === "periodic") && phase === null) {
    throw new Error(`sample.phase is required for ${kind} samples`);
  }
  const sample: RunnerComparisonSample = {
    v: 2,
    sequence: nonNegativeInteger(parsed.sequence, "sample.sequence"),
    kind,
    phase,
    at: timestamp(parsed.at),
    target: label(parsed.target, "sample.target"),
    shard: nullableLabel(parsed.shard, "sample.shard"),
    cpu: parseCpu(parsed.cpu),
    load: parseLoad(parsed.load),
    memory: parseMemory(parsed.memory),
    pressure: parsePressure(parsed.pressure),
    workspace: parseWorkspace(parsed.workspace),
    docker: parseDocker(parsed.docker),
    largestProcess: parseLargestProcess(parsed.largestProcess),
  };
  const endpoint = kind === "initialize" || kind === "finalize";
  if (endpoint && sample.largestProcess !== null) {
    throw new Error(`${kind} samples must not contain process evidence`);
  }
  if (
    (endpoint || kind === "periodic") &&
    Object.values(sample.docker).some((value) => value !== null)
  ) {
    throw new Error(`${kind} samples must not contain Docker evidence`);
  }
  if (JSON.stringify(sample) !== line) {
    throw new Error("runner comparison sample must use the canonical JSON encoding");
  }
  return sample;
}

export function parseRunnerComparisonSample(line: string): ParsedRunnerComparisonSample {
  if (Buffer.byteLength(line) > SAMPLE_LINE_MAX_BYTES) {
    throw new Error("runner comparison sample exceeds its size bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("runner comparison sample must be valid JSON");
  }
  return parseSampleObject(record(parsed, "sample"), line);
}

export function renderRunnerComparisonSample(sample: RunnerComparisonSample): string {
  const parsed = parseRunnerComparisonSample(JSON.stringify(sample));
  if (parsed.v !== 2) throw new Error("new runner comparison samples must use schema v2");
  return JSON.stringify(parsed);
}

function sameIdentity(left: RunnerComparisonIdentity, right: RunnerComparisonIdentity): boolean {
  return left.target === right.target && left.shard === right.shard;
}

function validateLegacyLedger(samples: readonly RunnerComparisonSampleV1[]): void {
  if (samples.length < 1 || samples.length > 2) {
    throw new Error("runner comparison v1 ledger must contain one or two samples");
  }
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (!sameIdentity(previous, current)) {
      throw new Error("runner comparison sample identity changed during the job");
    }
    if (Date.parse(current.at) <= Date.parse(previous.at)) {
      throw new Error("runner comparison v1 timestamps must increase");
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
}

function stableObserved(
  samples: readonly RunnerComparisonSample[],
  read: (sample: RunnerComparisonSample) => number | null,
  field: string,
): void {
  let last: number | null = null;
  for (const sample of samples) {
    const value = read(sample);
    if (value === null) continue;
    if (last !== null && value !== last) throw new Error(`${field} must remain stable`);
    last = value;
  }
}

function monotonicObserved(
  samples: readonly RunnerComparisonSample[],
  read: (sample: RunnerComparisonSample) => number | null,
  field: string,
): void {
  let last: number | null = null;
  for (const sample of samples) {
    const value = read(sample);
    if (value === null) continue;
    if (last !== null && value < last) throw new Error(`${field} must be monotonic`);
    last = value;
  }
}

function validateCpuHistory(samples: readonly RunnerComparisonSample[]): void {
  let previous: NonNullable<RunnerComparisonSample["cpu"]> | null = null;
  for (const sample of samples) {
    if (sample.cpu === null) continue;
    if (previous !== null) {
      const totalDelta = sample.cpu.totalTicks - previous.totalTicks;
      const idleDelta = sample.cpu.idleTicks - previous.idleTicks;
      if (
        sample.cpu.logicalCpuCount !== previous.logicalCpuCount ||
        totalDelta < 0 ||
        idleDelta < 0 ||
        idleDelta > totalDelta
      ) {
        throw new Error("runner comparison CPU counters must be monotonic and use one capacity");
      }
    }
    previous = sample.cpu;
  }
}

function validateCurrentLedger(samples: readonly RunnerComparisonSample[]): void {
  if (samples.length < 1 || samples.length > RUNNER_COMPARISON_MAX_SAMPLES) {
    throw new Error(
      `runner comparison v2 ledger must contain between one and ${RUNNER_COMPARISON_MAX_SAMPLES} samples`,
    );
  }
  if (
    samples[0]!.sequence !== 0 ||
    samples[0]!.kind !== "initialize" ||
    samples[0]!.phase !== null
  ) {
    throw new Error("runner comparison v2 ledger must start with sequence-zero initialization");
  }
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (current.sequence !== index) {
      throw new Error("runner comparison sample sequence must increase by one");
    }
    if (current.kind === "initialize") {
      throw new Error("runner comparison initialization may only be the first sample");
    }
    if (previous.kind === "finalize") {
      throw new Error("runner comparison finalization must be the last sample");
    }
    if (!sameIdentity(previous, current)) {
      throw new Error("runner comparison sample identity changed during the job");
    }
    if (Date.parse(current.at) < Date.parse(previous.at)) {
      throw new Error("runner comparison timestamps must not decrease");
    }
  }
  validateCpuHistory(samples);
  stableObserved(samples, (sample) => sample.memory.totalKb, "memory capacity");
  stableObserved(samples, (sample) => sample.memory.swapTotalKb, "swap capacity");
  stableObserved(
    samples,
    (sample) => sample.memory.rootCgroupLimitBytes,
    "root cgroup memory limit",
  );
  stableObserved(samples, (sample) => sample.workspace.totalBytes, "workspace capacity");
  monotonicObserved(
    samples,
    (sample) => sample.memory.rootCgroupPeakBytes,
    "root cgroup memory peak",
  );
  monotonicObserved(samples, (sample) => sample.memory.rootCgroupOom, "cgroup OOM counter");
  monotonicObserved(
    samples,
    (sample) => sample.memory.rootCgroupOomKill,
    "cgroup OOM-kill counter",
  );
}

export function parseRunnerComparisonLedger(
  contents: string,
): RunnerComparisonSampleV1[] | RunnerComparisonSample[] {
  if (Buffer.byteLength(contents) > RUNNER_COMPARISON_LEDGER_MAX_BYTES) {
    throw new Error("runner comparison ledger exceeds its size bound");
  }
  const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 1) throw new Error("runner comparison ledger must contain a sample");
  if (contents !== `${lines.join("\n")}\n`) {
    throw new Error("runner comparison ledger must use the canonical JSONL encoding");
  }
  const samples = lines.map(parseRunnerComparisonSample);
  const version = samples[0]!.v;
  if (samples.some((sample) => sample.v !== version)) {
    throw new Error("runner comparison ledger must not mix schema versions");
  }
  if (version === 1) {
    const legacy = samples as RunnerComparisonSampleV1[];
    validateLegacyLedger(legacy);
    return legacy;
  }
  const current = samples as RunnerComparisonSample[];
  validateCurrentLedger(current);
  return current;
}

export function renderRunnerComparisonLedger(samples: readonly RunnerComparisonSample[]): string {
  const contents = `${samples.map(renderRunnerComparisonSample).join("\n")}\n`;
  const parsed = parseRunnerComparisonLedger(contents);
  if (parsed[0]?.v !== 2) throw new Error("new runner comparison ledgers must use schema v2");
  return contents;
}
