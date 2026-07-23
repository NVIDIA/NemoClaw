// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseRunnerComparisonSample,
  type RunnerComparisonIdentity,
  type RunnerComparisonSample,
  type RunnerComparisonSampleKind,
} from "./runner-comparison-schema.mts";
import { parseCpuTicks, parseMeminfo, type ResourceSnapshot } from "./runner-pressure-core.mts";

export interface RunnerComparisonSampleMetadata {
  sequence: number;
  kind: RunnerComparisonSampleKind;
  phase: string | null;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function paired<T>(
  left: T | null | undefined,
  right: T | null | undefined,
  leftKey: string,
  rightKey: string,
): Record<string, T | null> {
  return left !== null && left !== undefined && right !== null && right !== undefined
    ? { [leftKey]: left, [rightKey]: right }
    : { [leftKey]: null, [rightKey]: null };
}

/** Map one secret-safe pressure snapshot into the canonical comparison ledger. */
export function collectRunnerComparisonSample(
  identity: RunnerComparisonIdentity,
  metadata: RunnerComparisonSampleMetadata,
  snapshot: ResourceSnapshot,
): RunnerComparisonSample {
  const meminfo = snapshot.meminfo;
  const candidate: RunnerComparisonSample = {
    v: 2,
    sequence: metadata.sequence,
    kind: metadata.kind,
    phase: metadata.phase,
    at: snapshot.at,
    target: identity.target,
    shard: identity.shard,
    cpu: snapshot.cpu,
    load: {
      oneMinute: snapshot.load?.load1 ?? null,
      fiveMinutes: snapshot.load?.load5 ?? null,
      fifteenMinutes: snapshot.load?.load15 ?? null,
    },
    memory: {
      totalKb: meminfo?.memTotalKb ?? null,
      availableKb: meminfo?.memAvailableKb ?? null,
      cachedKb: meminfo?.cachedKb ?? null,
      sReclaimableKb: meminfo?.sReclaimableKb ?? null,
      ...(paired(meminfo?.swapTotalKb, meminfo?.swapFreeKb, "swapTotalKb", "swapFreeKb") as Pick<
        RunnerComparisonSample["memory"],
        "swapTotalKb" | "swapFreeKb"
      >),
      rootCgroupCurrentBytes: snapshot.cgroup?.currentBytes ?? null,
      rootCgroupPeakBytes: snapshot.cgroup?.peakBytes ?? null,
      rootCgroupLimitBytes: snapshot.cgroup?.limitBytes ?? null,
      ...(paired(
        snapshot.cgroup?.events?.oom,
        snapshot.cgroup?.events?.oomKill,
        "rootCgroupOom",
        "rootCgroupOomKill",
      ) as Pick<RunnerComparisonSample["memory"], "rootCgroupOom" | "rootCgroupOomKill">),
    },
    pressure: {
      memoryFullAvg60: snapshot.memoryPressure?.fullAvg60 ?? null,
      ioFullAvg60: snapshot.ioPressure?.fullAvg60 ?? null,
    },
    workspace: {
      ...(paired(
        snapshot.disk?.totalBytes,
        snapshot.disk?.freeBytes,
        "totalBytes",
        "freeBytes",
      ) as Pick<RunnerComparisonSample["workspace"], "totalBytes" | "freeBytes">),
      ...(paired(
        snapshot.disk?.inodesTotal,
        snapshot.disk?.inodesFree,
        "inodesTotal",
        "inodesFree",
      ) as Pick<RunnerComparisonSample["workspace"], "inodesTotal" | "inodesFree">),
    },
    docker: {
      imagesBytes: snapshot.dockerDisk?.imagesBytes ?? null,
      containersBytes: snapshot.dockerDisk?.containersBytes ?? null,
      buildCacheBytes: snapshot.dockerDisk?.buildCacheBytes ?? null,
      maximumContainerMemoryBytes: maximum(
        snapshot.containers.map((container) => container.memBytes),
      ),
      maximumContainerCpuPercent:
        snapshot.maximumContainerCpuPercent ??
        maximum(snapshot.containers.map((container) => container.cpuPercent)),
    },
    largestProcess: snapshot.largestProcess,
  };
  const parsed = parseRunnerComparisonSample(JSON.stringify(candidate));
  if (parsed.v !== 2) throw new Error("collected runner comparison sample must use schema v2");
  return parsed;
}

/** Preserve the #7399 parser export while v2 collection consumes snapshots. */
export function parseCpuStat(text: string): RunnerComparisonSample["cpu"] {
  return parseCpuTicks(text);
}

/** Preserve the exact #7399 meminfo parser return shape. */
export function parseComparisonMeminfo(text: string): {
  totalKb: number | null;
  availableKb: number | null;
} {
  const parsed = parseMeminfo(text);
  return { totalKb: parsed.memTotalKb, availableKb: parsed.memAvailableKb };
}
