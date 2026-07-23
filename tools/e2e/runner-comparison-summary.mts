// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ParsedRunnerComparisonSample,
  parseRunnerComparisonLedger,
  RUNNER_COMPARISON_MAX_SAMPLES,
  RUNNER_COMPARISON_SUMMARY_MAX_BYTES,
  type RunnerComparisonIdentity,
  type RunnerComparisonProcessClass,
  type RunnerComparisonSample,
  type RunnerComparisonSampleV1,
} from "./runner-comparison-schema.mts";
import { PROCESS_CLASSES } from "./runner-pressure-core.mts";

export interface RunnerComparisonSummaryV1 extends RunnerComparisonIdentity {
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

export interface RunnerComparisonSummary extends RunnerComparisonIdentity {
  v: 2;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sampleCount: number;
  cpu: {
    logicalCpuCount: number | null;
    averageBusyPercent: number | null;
    averageBusyLogicalCpus: number | null;
    maximumBusy: { percent: number | null; phase: string | null };
  };
  load: { maximumOneMinute: { value: number | null; phase: string | null } };
  memory: {
    totalKb: number | null;
    startAvailableKb: number | null;
    endAvailableKb: number | null;
    minimumAvailable: { kb: number | null; phase: string | null };
    maximumUsed: { kb: number | null; phase: string | null };
    maximumCached: { kb: number | null; phase: string | null };
    maximumSReclaimable: { kb: number | null; phase: string | null };
    swapTotalKb: number | null;
    maximumSwapUsed: { kb: number | null; phase: string | null };
    cgroup: {
      limitBytes: number | null;
      peakBytes: number | null;
      maximumCurrent: { bytes: number | null; phase: string | null };
      oomDelta: number | null;
      oomKillDelta: number | null;
    };
  };
  pressure: {
    maximumMemoryFullAvg60: { percent: number | null; phase: string | null };
    maximumIoFullAvg60: { percent: number | null; phase: string | null };
  };
  workspace: {
    totalBytes: number | null;
    startFreeBytes: number | null;
    endFreeBytes: number | null;
    netGrowthBytes: number | null;
    minimumFree: { bytes: number | null; phase: string | null };
    inodesTotal: number | null;
    minimumInodesFree: { count: number | null; phase: string | null };
  };
  docker: {
    maximumImages: { bytes: number | null; phase: string | null };
    maximumContainers: { bytes: number | null; phase: string | null };
    maximumBuildCache: { bytes: number | null; phase: string | null };
    maximumContainerMemory: { bytes: number | null; phase: string | null };
    maximumContainerCpu: { percent: number | null; phase: string | null };
  };
  largestProcess: {
    rssKb: number | null;
    class: RunnerComparisonProcessClass | null;
    phase: string | null;
  };
}

export type ParsedRunnerComparisonSummary = RunnerComparisonSummaryV1 | RunnerComparisonSummary;

function rounded(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function minimum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

function commonObserved(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 && present.every((value) => value === present[0])
    ? (present[0] ?? null)
    : null;
}

function phaseFor(
  sample: RunnerComparisonSample,
  index: number,
  samples: readonly RunnerComparisonSample[],
): string | null {
  if (sample.kind === "initialize") return null;
  if (sample.phase !== null) return sample.phase;
  if (sample.kind === "finalize") return samples[index - 1]?.phase ?? null;
  return null;
}

function extremum(
  samples: readonly RunnerComparisonSample[],
  read: (sample: RunnerComparisonSample) => number | null,
  direction: "maximum" | "minimum",
): { value: number | null; phase: string | null } {
  let selected: { value: number; phase: string | null } | null = null;
  for (const [index, sample] of samples.entries()) {
    const value = read(sample);
    if (value === null) continue;
    const phase = phaseFor(sample, index, samples);
    if (
      selected === null ||
      (direction === "maximum" ? value > selected.value : value < selected.value) ||
      (value === selected.value && selected.phase === null && phase !== null)
    ) {
      selected = { value, phase };
    }
  }
  return selected ?? { value: null, phase: null };
}

function endpointDelta(start: number | null, finish: number | null): number | null {
  return start === null || finish === null ? null : finish - start;
}

function averageCpu(start: RunnerComparisonSample["cpu"], finish: RunnerComparisonSample["cpu"]) {
  if (start === null || finish === null || start.logicalCpuCount !== finish.logicalCpuCount) {
    return {
      logicalCpuCount: null,
      averageBusyPercent: null,
      averageBusyLogicalCpus: null,
    };
  }
  const totalDelta = finish.totalTicks - start.totalTicks;
  const idleDelta = finish.idleTicks - start.idleTicks;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
    return {
      logicalCpuCount: null,
      averageBusyPercent: null,
      averageBusyLogicalCpus: null,
    };
  }
  const busy = (totalDelta - idleDelta) / totalDelta;
  return {
    logicalCpuCount: start.logicalCpuCount,
    averageBusyPercent: rounded(busy * 100, 2),
    averageBusyLogicalCpus: rounded(busy * start.logicalCpuCount, 3),
  };
}

function summarizeLegacy(samples: readonly RunnerComparisonSampleV1[]): RunnerComparisonSummaryV1 {
  if (samples.length !== 2) throw new Error("v1 summary requires exactly two samples");
  const start = samples[0]!;
  const finish = samples[1]!;
  const durationMs = Date.parse(finish.at) - Date.parse(start.at);
  if (durationMs <= 0) throw new Error("runner comparison duration must be positive");
  const cpu = averageCpu(start.cpu, finish.cpu);
  const totalKb =
    start.memory.totalKb !== null && start.memory.totalKb === finish.memory.totalKb
      ? start.memory.totalKb
      : null;
  const totalBytes =
    start.workspace.totalBytes !== null &&
    start.workspace.totalBytes === finish.workspace.totalBytes
      ? start.workspace.totalBytes
      : null;
  return {
    v: 1,
    target: start.target,
    shard: start.shard,
    startedAt: start.at,
    finishedAt: finish.at,
    durationMs,
    sampleCount: 2,
    cpu,
    memory: {
      totalKb,
      startAvailableKb: start.memory.availableKb,
      endAvailableKb: finish.memory.availableKb,
      maximumEndpointUsedKb: maximum(
        [start.memory.availableKb, finish.memory.availableKb].map((available) =>
          totalKb !== null && available !== null ? totalKb - available : null,
        ),
      ),
      rootCgroupPeakBytes: maximum(samples.map((sample) => sample.memory.rootCgroupPeakBytes)),
    },
    workspace: {
      totalBytes,
      startFreeBytes: start.workspace.freeBytes,
      endFreeBytes: finish.workspace.freeBytes,
      netGrowthBytes:
        start.workspace.freeBytes !== null && finish.workspace.freeBytes !== null
          ? start.workspace.freeBytes - finish.workspace.freeBytes
          : null,
      minimumEndpointFreeBytes: minimum(samples.map((sample) => sample.workspace.freeBytes)),
    },
  };
}

function maximumBusyWindow(samples: readonly RunnerComparisonSample[]) {
  let selected: { percent: number | null; phase: string | null } = {
    percent: null,
    phase: null,
  };
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (previous.cpu === null || current.cpu === null) continue;
    const totalDelta = current.cpu.totalTicks - previous.cpu.totalTicks;
    const idleDelta = current.cpu.idleTicks - previous.cpu.idleTicks;
    if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) continue;
    const percent = rounded(((totalDelta - idleDelta) / totalDelta) * 100, 2);
    const phase = current.kind === "scenario-start" ? null : phaseFor(current, index, samples);
    if (selected.percent === null || percent > selected.percent) {
      selected = { percent, phase };
    }
  }
  return selected;
}

function summarizeCurrent(samples: readonly RunnerComparisonSample[]): RunnerComparisonSummary {
  if (samples.length < 2) throw new Error("v2 summary requires at least two samples");
  const start = samples[0]!;
  const finish = samples.at(-1)!;
  const durationMs = Date.parse(finish.at) - Date.parse(start.at);
  if (durationMs <= 0) throw new Error("runner comparison duration must be positive");
  const totalKb = commonObserved(samples.map((sample) => sample.memory.totalKb));
  const swapTotalKb = commonObserved(samples.map((sample) => sample.memory.swapTotalKb));
  const minimumAvailable = extremum(samples, (sample) => sample.memory.availableKb, "minimum");
  const maximumUsed = extremum(
    samples,
    (sample) =>
      totalKb !== null && sample.memory.availableKb !== null
        ? totalKb - sample.memory.availableKb
        : null,
    "maximum",
  );
  const maximumCached = extremum(samples, (sample) => sample.memory.cachedKb, "maximum");
  const maximumSReclaimable = extremum(
    samples,
    (sample) => sample.memory.sReclaimableKb,
    "maximum",
  );
  const maximumSwapUsed = extremum(
    samples,
    (sample) =>
      swapTotalKb !== null && sample.memory.swapFreeKb !== null
        ? swapTotalKb - sample.memory.swapFreeKb
        : null,
    "maximum",
  );
  const maximumCurrent = extremum(
    samples,
    (sample) => sample.memory.rootCgroupCurrentBytes,
    "maximum",
  );
  const minimumFree = extremum(samples, (sample) => sample.workspace.freeBytes, "minimum");
  const minimumInodesFree = extremum(samples, (sample) => sample.workspace.inodesFree, "minimum");
  const maximumProcess = samples.reduce<{
    rssKb: number;
    class: RunnerComparisonProcessClass;
    phase: string | null;
  } | null>((selected, sample, index) => {
    if (sample.largestProcess === null) return selected;
    if (selected !== null && selected.rssKb >= sample.largestProcess.rssKb) return selected;
    return { ...sample.largestProcess, phase: phaseFor(sample, index, samples) };
  }, null);
  const metric = (
    read: (sample: RunnerComparisonSample) => number | null,
    direction: "maximum" | "minimum" = "maximum",
  ) => extremum(samples, read, direction);
  const asMetric = <K extends string>(
    key: K,
    value: { value: number | null; phase: string | null },
  ) =>
    ({ [key]: value.value, phase: value.phase }) as Record<K, number | null> & {
      phase: string | null;
    };

  return {
    v: 2,
    target: start.target,
    shard: start.shard,
    startedAt: start.at,
    finishedAt: finish.at,
    durationMs,
    sampleCount: samples.length,
    cpu: { ...averageCpu(start.cpu, finish.cpu), maximumBusy: maximumBusyWindow(samples) },
    load: {
      maximumOneMinute: asMetric(
        "value",
        metric((sample) => sample.load.oneMinute),
      ),
    },
    memory: {
      totalKb,
      startAvailableKb: start.memory.availableKb,
      endAvailableKb: finish.memory.availableKb,
      minimumAvailable: asMetric("kb", minimumAvailable),
      maximumUsed: asMetric("kb", maximumUsed),
      maximumCached: asMetric("kb", maximumCached),
      maximumSReclaimable: asMetric("kb", maximumSReclaimable),
      swapTotalKb,
      maximumSwapUsed: asMetric("kb", maximumSwapUsed),
      cgroup: {
        limitBytes: commonObserved(samples.map((sample) => sample.memory.rootCgroupLimitBytes)),
        peakBytes: maximum(samples.map((sample) => sample.memory.rootCgroupPeakBytes)),
        maximumCurrent: asMetric("bytes", maximumCurrent),
        oomDelta: endpointDelta(start.memory.rootCgroupOom, finish.memory.rootCgroupOom),
        oomKillDelta: endpointDelta(
          start.memory.rootCgroupOomKill,
          finish.memory.rootCgroupOomKill,
        ),
      },
    },
    pressure: {
      maximumMemoryFullAvg60: asMetric(
        "percent",
        metric((sample) => sample.pressure.memoryFullAvg60),
      ),
      maximumIoFullAvg60: asMetric(
        "percent",
        metric((sample) => sample.pressure.ioFullAvg60),
      ),
    },
    workspace: {
      totalBytes: commonObserved(samples.map((sample) => sample.workspace.totalBytes)),
      startFreeBytes: start.workspace.freeBytes,
      endFreeBytes: finish.workspace.freeBytes,
      netGrowthBytes:
        start.workspace.freeBytes !== null && finish.workspace.freeBytes !== null
          ? start.workspace.freeBytes - finish.workspace.freeBytes
          : null,
      minimumFree: asMetric("bytes", minimumFree),
      inodesTotal: commonObserved(samples.map((sample) => sample.workspace.inodesTotal)),
      minimumInodesFree: asMetric("count", minimumInodesFree),
    },
    docker: {
      maximumImages: asMetric(
        "bytes",
        metric((sample) => sample.docker.imagesBytes),
      ),
      maximumContainers: asMetric(
        "bytes",
        metric((sample) => sample.docker.containersBytes),
      ),
      maximumBuildCache: asMetric(
        "bytes",
        metric((sample) => sample.docker.buildCacheBytes),
      ),
      maximumContainerMemory: asMetric(
        "bytes",
        metric((sample) => sample.docker.maximumContainerMemoryBytes),
      ),
      maximumContainerCpu: asMetric(
        "percent",
        metric((sample) => sample.docker.maximumContainerCpuPercent),
      ),
    },
    largestProcess: {
      rssKb: maximumProcess?.rssKb ?? null,
      class: maximumProcess?.class ?? null,
      phase: maximumProcess?.phase ?? null,
    },
  };
}

export function summarizeRunnerComparison(
  samples: readonly ParsedRunnerComparisonSample[],
): ParsedRunnerComparisonSummary {
  if (samples.length < 1) throw new Error("runner comparison samples are required");
  const validated = parseRunnerComparisonLedger(
    `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
  );
  if (validated[0]!.v === 1) {
    if (validated.length !== 2) throw new Error("v1 summary requires exactly two samples");
    return summarizeLegacy(validated as RunnerComparisonSampleV1[]);
  }
  const current = validated as RunnerComparisonSample[];
  if (current.at(-1)?.kind !== "finalize") {
    throw new Error("v2 summary requires a final sample");
  }
  return summarizeCurrent(current);
}

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const parsed = value as UnknownRecord;
  const actual = Object.keys(parsed).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has an unsupported shape`);
  }
  return parsed;
}

function integer(value: unknown, field: string, nullable = true): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer${nullable ? " or null" : ""}`);
  }
  return value;
}

function number_(value: unknown, field: string, percentage = false): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (percentage && value > 100)
  ) {
    throw new Error(`${field} must be a valid non-negative number`);
  }
  return value;
}

function label(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(`${field} must be a bounded label or null`);
  }
  return value;
}

function metric(
  value: unknown,
  key: string,
  field: string,
  parse: (value: unknown, field: string) => number | null,
): number | null {
  const parsed = object(value, field, [key, "phase"]);
  const measured = parse(parsed[key], `${field}.${key}`);
  const phase = label(parsed.phase, `${field}.phase`);
  if (measured === null && phase !== null) throw new Error(`${field}.phase requires a value`);
  return measured;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a canonical timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical timestamp`);
  }
  return value;
}

function requiredLabel(value: unknown, field: string): string {
  const parsed = label(value, field);
  if (parsed === null) throw new Error(`${field} is required`);
  return parsed;
}

function signedInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer or null`);
  }
  return value;
}

function validateLegacy(value: unknown): asserts value is RunnerComparisonSummaryV1 {
  const root = object(value, "summary", [
    "v",
    "target",
    "shard",
    "startedAt",
    "finishedAt",
    "durationMs",
    "sampleCount",
    "cpu",
    "memory",
    "workspace",
  ]);
  if (root.v !== 1) throw new Error("summary.v must be 1");
  requiredLabel(root.target, "summary.target");
  label(root.shard, "summary.shard");
  const cpu = object(root.cpu, "summary.cpu", [
    "logicalCpuCount",
    "averageBusyPercent",
    "averageBusyLogicalCpus",
  ]);
  const logicalCpuCount = integer(cpu.logicalCpuCount, "summary.cpu.logicalCpuCount");
  const averageBusyPercent = number_(
    cpu.averageBusyPercent,
    "summary.cpu.averageBusyPercent",
    true,
  );
  const averageBusyLogicalCpus = number_(
    cpu.averageBusyLogicalCpus,
    "summary.cpu.averageBusyLogicalCpus",
  );
  const cpuValues = [logicalCpuCount, averageBusyPercent, averageBusyLogicalCpus];
  if (cpuValues.some((entry) => entry === null) && cpuValues.some((entry) => entry !== null)) {
    throw new Error("summary.cpu fields must be all present or all null");
  }
  if (logicalCpuCount === 0) throw new Error("summary.cpu.logicalCpuCount must be positive");
  if (
    logicalCpuCount !== null &&
    averageBusyLogicalCpus !== null &&
    averageBusyLogicalCpus > logicalCpuCount
  ) {
    throw new Error("summary.cpu average cannot exceed logical CPU capacity");
  }

  const memory = object(root.memory, "summary.memory", [
    "totalKb",
    "startAvailableKb",
    "endAvailableKb",
    "maximumEndpointUsedKb",
    "rootCgroupPeakBytes",
  ]);
  const totalKb = integer(memory.totalKb, "summary.memory.totalKb");
  const startAvailableKb = integer(memory.startAvailableKb, "summary.memory.startAvailableKb");
  const endAvailableKb = integer(memory.endAvailableKb, "summary.memory.endAvailableKb");
  const maximumEndpointUsedKb = integer(
    memory.maximumEndpointUsedKb,
    "summary.memory.maximumEndpointUsedKb",
  );
  integer(memory.rootCgroupPeakBytes, "summary.memory.rootCgroupPeakBytes");
  for (const available of [startAvailableKb, endAvailableKb]) {
    if (totalKb !== null && available !== null && available > totalKb) {
      throw new Error("summary memory available cannot exceed totalKb");
    }
  }
  const expectedMaximumUsed =
    totalKb === null
      ? null
      : maximum(
          [startAvailableKb, endAvailableKb].map((available) =>
            available === null ? null : totalKb - available,
          ),
        );
  if (maximumEndpointUsedKb !== expectedMaximumUsed) {
    throw new Error("summary maximum endpoint memory must match endpoint availability");
  }

  const workspace = object(root.workspace, "summary.workspace", [
    "totalBytes",
    "startFreeBytes",
    "endFreeBytes",
    "netGrowthBytes",
    "minimumEndpointFreeBytes",
  ]);
  const totalBytes = integer(workspace.totalBytes, "summary.workspace.totalBytes");
  const startFreeBytes = integer(workspace.startFreeBytes, "summary.workspace.startFreeBytes");
  const endFreeBytes = integer(workspace.endFreeBytes, "summary.workspace.endFreeBytes");
  const netGrowthBytes = signedInteger(
    workspace.netGrowthBytes,
    "summary.workspace.netGrowthBytes",
  );
  const minimumEndpointFreeBytes = integer(
    workspace.minimumEndpointFreeBytes,
    "summary.workspace.minimumEndpointFreeBytes",
  );
  for (const free of [startFreeBytes, endFreeBytes, minimumEndpointFreeBytes]) {
    if (totalBytes !== null && free !== null && free > totalBytes) {
      throw new Error("summary workspace free bytes cannot exceed total bytes");
    }
  }
  const expectedGrowth =
    startFreeBytes === null || endFreeBytes === null ? null : startFreeBytes - endFreeBytes;
  if (netGrowthBytes !== expectedGrowth) {
    throw new Error("summary workspace growth must match endpoint free space");
  }
  if (minimumEndpointFreeBytes !== minimum([startFreeBytes, endFreeBytes])) {
    throw new Error("summary minimum endpoint free space must match its endpoints");
  }

  if (
    integer(root.durationMs, "summary.durationMs", false)! < 1 ||
    integer(root.sampleCount, "summary.sampleCount", false) !== 2
  ) {
    throw new Error("summary v1 must describe two samples over a positive duration");
  }
  const startedAt = timestamp(root.startedAt, "summary.startedAt");
  const finishedAt = timestamp(root.finishedAt, "summary.finishedAt");
  if (Date.parse(finishedAt) - Date.parse(startedAt) !== root.durationMs) {
    throw new Error("summary duration must match its timestamps");
  }
}

function validateCurrent(value: unknown): asserts value is RunnerComparisonSummary {
  const root = object(value, "summary", [
    "v",
    "target",
    "shard",
    "startedAt",
    "finishedAt",
    "durationMs",
    "sampleCount",
    "cpu",
    "load",
    "memory",
    "pressure",
    "workspace",
    "docker",
    "largestProcess",
  ]);
  if (root.v !== 2) throw new Error("summary.v must be 2");
  const durationMs = integer(root.durationMs, "summary.durationMs", false)!;
  const sampleCount = integer(root.sampleCount, "summary.sampleCount", false)!;
  if (durationMs < 1 || sampleCount < 2 || sampleCount > RUNNER_COMPARISON_MAX_SAMPLES) {
    throw new Error("summary duration or sample count is outside the supported bound");
  }
  const startedAt = timestamp(root.startedAt, "summary.startedAt");
  const finishedAt = timestamp(root.finishedAt, "summary.finishedAt");
  if (Date.parse(finishedAt) - Date.parse(startedAt) !== durationMs) {
    throw new Error("summary duration must match its timestamps");
  }
  label(root.shard, "summary.shard");
  if (typeof root.target !== "string" || label(root.target, "summary.target") === null) {
    throw new Error("summary.target is required");
  }

  const cpu = object(root.cpu, "summary.cpu", [
    "logicalCpuCount",
    "averageBusyPercent",
    "averageBusyLogicalCpus",
    "maximumBusy",
  ]);
  const logicalCpuCount = integer(cpu.logicalCpuCount, "summary.cpu.logicalCpuCount");
  if (logicalCpuCount === 0) throw new Error("summary.cpu.logicalCpuCount must be positive");
  const averagePercent = number_(cpu.averageBusyPercent, "summary.cpu.averageBusyPercent", true);
  const averageCpus = number_(cpu.averageBusyLogicalCpus, "summary.cpu.averageBusyLogicalCpus");
  const cpuValues = [logicalCpuCount, averagePercent, averageCpus];
  if (cpuValues.some((entry) => entry === null) && cpuValues.some((entry) => entry !== null)) {
    throw new Error("summary.cpu average fields must be all present or all null");
  }
  if (logicalCpuCount !== null && averageCpus !== null && averageCpus > logicalCpuCount) {
    throw new Error("summary.cpu average cannot exceed logical CPU capacity");
  }
  metric(cpu.maximumBusy, "percent", "summary.cpu.maximumBusy", (value, field) =>
    number_(value, field, true),
  );
  const load = object(root.load, "summary.load", ["maximumOneMinute"]);
  metric(load.maximumOneMinute, "value", "summary.load.maximumOneMinute", number_);

  const memory = object(root.memory, "summary.memory", [
    "totalKb",
    "startAvailableKb",
    "endAvailableKb",
    "minimumAvailable",
    "maximumUsed",
    "maximumCached",
    "maximumSReclaimable",
    "swapTotalKb",
    "maximumSwapUsed",
    "cgroup",
  ]);
  const totalKb = integer(memory.totalKb, "summary.memory.totalKb");
  const startAvailable = integer(memory.startAvailableKb, "summary.memory.startAvailableKb");
  const endAvailable = integer(memory.endAvailableKb, "summary.memory.endAvailableKb");
  const minimumAvailable = metric(
    memory.minimumAvailable,
    "kb",
    "summary.memory.minimumAvailable",
    integer,
  );
  const maximumUsed = metric(memory.maximumUsed, "kb", "summary.memory.maximumUsed", integer);
  const maximumCached = metric(memory.maximumCached, "kb", "summary.memory.maximumCached", integer);
  const maximumReclaimable = metric(
    memory.maximumSReclaimable,
    "kb",
    "summary.memory.maximumSReclaimable",
    integer,
  );
  const swapTotal = integer(memory.swapTotalKb, "summary.memory.swapTotalKb");
  const maximumSwapUsed = metric(
    memory.maximumSwapUsed,
    "kb",
    "summary.memory.maximumSwapUsed",
    integer,
  );
  for (const available of [
    startAvailable,
    endAvailable,
    minimumAvailable,
    maximumCached,
    maximumReclaimable,
  ]) {
    if (totalKb !== null && available !== null && available > totalKb) {
      throw new Error("summary memory measurement cannot exceed totalKb");
    }
  }
  if (totalKb !== null && maximumUsed !== null && maximumUsed > totalKb) {
    throw new Error("summary maximum memory used cannot exceed totalKb");
  }
  if (totalKb === null && maximumUsed !== null) {
    throw new Error("summary maximum memory used requires totalKb");
  }
  if (swapTotal !== null && maximumSwapUsed !== null && maximumSwapUsed > swapTotal) {
    throw new Error("summary maximum swap used cannot exceed swapTotalKb");
  }
  if (swapTotal === null && maximumSwapUsed !== null) {
    throw new Error("summary maximum swap used requires swapTotalKb");
  }
  const cgroup = object(memory.cgroup, "summary.memory.cgroup", [
    "limitBytes",
    "peakBytes",
    "maximumCurrent",
    "oomDelta",
    "oomKillDelta",
  ]);
  const peak = integer(cgroup.peakBytes, "summary.memory.cgroup.peakBytes");
  const current = metric(
    cgroup.maximumCurrent,
    "bytes",
    "summary.memory.cgroup.maximumCurrent",
    integer,
  );
  integer(cgroup.limitBytes, "summary.memory.cgroup.limitBytes");
  integer(cgroup.oomDelta, "summary.memory.cgroup.oomDelta");
  integer(cgroup.oomKillDelta, "summary.memory.cgroup.oomKillDelta");
  if (peak !== null && current !== null && current > peak) {
    throw new Error("summary cgroup current cannot exceed peak");
  }

  const pressure = object(root.pressure, "summary.pressure", [
    "maximumMemoryFullAvg60",
    "maximumIoFullAvg60",
  ]);
  for (const [key, entry] of Object.entries(pressure)) {
    metric(entry, "percent", `summary.pressure.${key}`, (value, field) =>
      number_(value, field, true),
    );
  }
  const workspace = object(root.workspace, "summary.workspace", [
    "totalBytes",
    "startFreeBytes",
    "endFreeBytes",
    "netGrowthBytes",
    "minimumFree",
    "inodesTotal",
    "minimumInodesFree",
  ]);
  const totalBytes = integer(workspace.totalBytes, "summary.workspace.totalBytes");
  const startFree = integer(workspace.startFreeBytes, "summary.workspace.startFreeBytes");
  const endFree = integer(workspace.endFreeBytes, "summary.workspace.endFreeBytes");
  const minimumFree = metric(
    workspace.minimumFree,
    "bytes",
    "summary.workspace.minimumFree",
    integer,
  );
  const netGrowth = workspace.netGrowthBytes;
  if (netGrowth !== null && (typeof netGrowth !== "number" || !Number.isSafeInteger(netGrowth))) {
    throw new Error("summary.workspace.netGrowthBytes must be a safe integer or null");
  }
  if (startFree !== null && endFree !== null && netGrowth !== startFree - endFree) {
    throw new Error("summary workspace growth must match endpoint free space");
  }
  if ((startFree === null || endFree === null) && netGrowth !== null) {
    throw new Error("summary workspace growth requires both endpoint measurements");
  }
  for (const free of [startFree, endFree, minimumFree]) {
    if (totalBytes !== null && free !== null && free > totalBytes) {
      throw new Error("summary workspace free bytes cannot exceed total bytes");
    }
  }
  const inodesTotal = integer(workspace.inodesTotal, "summary.workspace.inodesTotal");
  const inodesFree = metric(
    workspace.minimumInodesFree,
    "count",
    "summary.workspace.minimumInodesFree",
    integer,
  );
  if (inodesTotal !== null && inodesFree !== null && inodesFree > inodesTotal) {
    throw new Error("summary free inodes cannot exceed total inodes");
  }

  const docker = object(root.docker, "summary.docker", [
    "maximumImages",
    "maximumContainers",
    "maximumBuildCache",
    "maximumContainerMemory",
    "maximumContainerCpu",
  ]);
  for (const [key, entry] of Object.entries(docker)) {
    metric(
      entry,
      key === "maximumContainerCpu" ? "percent" : "bytes",
      `summary.docker.${key}`,
      key === "maximumContainerCpu" ? number_ : integer,
    );
  }
  const largest = object(root.largestProcess, "summary.largestProcess", [
    "rssKb",
    "class",
    "phase",
  ]);
  const rssKb = integer(largest.rssKb, "summary.largestProcess.rssKb");
  const class_ = largest.class;
  if (
    class_ !== null &&
    (typeof class_ !== "string" ||
      !PROCESS_CLASSES.includes(class_ as RunnerComparisonProcessClass))
  ) {
    throw new Error("summary.largestProcess.class must be a supported fixed value");
  }
  if ((rssKb === null) !== (class_ === null)) {
    throw new Error("summary largest process RSS and class must be present together");
  }
  const processPhase = label(largest.phase, "summary.largestProcess.phase");
  if ((rssKb === null) !== (processPhase === null)) {
    throw new Error("summary largest process RSS and phase must be present together");
  }
}

export function renderRunnerComparisonSummary(summary: ParsedRunnerComparisonSummary): string {
  if (summary.v === 1) validateLegacy(summary);
  else validateCurrent(summary);
  const serialized = JSON.stringify(summary, null, 2);
  if (Buffer.byteLength(serialized) > RUNNER_COMPARISON_SUMMARY_MAX_BYTES) {
    throw new Error("runner comparison summary exceeds its size bound");
  }
  return `${serialized}\n`;
}

export function parseRunnerComparisonSummary(contents: string): ParsedRunnerComparisonSummary {
  if (Buffer.byteLength(contents) > RUNNER_COMPARISON_SUMMARY_MAX_BYTES) {
    throw new Error("runner comparison summary exceeds its size bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("runner comparison summary must be valid JSON");
  }
  const version = (parsed as { v?: unknown } | null)?.v;
  if (version === 1) validateLegacy(parsed);
  else if (version === 2) validateCurrent(parsed);
  else throw new Error("summary.v must be 1 or 2");
  if (renderRunnerComparisonSummary(parsed) !== contents) {
    throw new Error("runner comparison summary must use canonical JSON encoding");
  }
  return parsed;
}
