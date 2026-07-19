// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource attribution, failure classification, and retry policy for hosted
 * E2E runners (#7146).
 *
 * Host-memory snapshots that only look at raw `MemFree` make healthy Linux
 * page cache look like memory exhaustion, and a GitHub-hosted VM can disappear
 * before cleanup or artifacts identify the cause. This module owns the
 * evidence contract that lets maintainers tell those cases apart:
 *
 * - pure parsers for `/proc`, cgroup v2, PSI, `ps`, and Docker CLI output;
 * - a bounded, secret-safe snapshot line built by an explicit field-by-field
 *   serializer (nothing outside the allowlisted shape can be emitted);
 * - a machine-readable terminal classification for ordinary failures; and
 * - a retry policy that permits at most one retry, and only for a confirmed
 *   hosted-runner-loss signature — never for assertions, deterministic
 *   failures, or classified OOM/disk failures.
 *
 * Interoperates with the #7101 phase-heartbeat contract by emitting single
 * prefixed lines a heartbeat stream can carry verbatim; it does not define a
 * second progress framework.
 */

const COMM_MAX_LENGTH = 32;
const CONTAINER_NAME_MAX_LENGTH = 64;
const TOP_PROCESS_LIMIT = 5;
const CONTAINER_STAT_LIMIT = 5;
export const SNAPSHOT_LINE_PREFIX = "E2E_RESOURCE_SNAPSHOT ";
export const CLASSIFICATION_LINE_PREFIX = "E2E_TERMINAL_CLASSIFICATION ";
export const SNAPSHOT_LINE_MAX_LENGTH = 4096;

/** Free-space floors below which a failure is attributed to disk pressure. */
export const MIN_DISK_FREE_BYTES = 512 * 1024 * 1024;
export const MIN_INODES_FREE = 1000;

// ── Parsers ──────────────────────────────────────────────────────────────────

export interface MeminfoSample {
  memTotalKb: number | null;
  memFreeKb: number | null;
  memAvailableKb: number | null;
  cachedKb: number | null;
  sReclaimableKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
}

const MEMINFO_FIELDS: Record<string, keyof MeminfoSample> = {
  MemTotal: "memTotalKb",
  MemFree: "memFreeKb",
  MemAvailable: "memAvailableKb",
  Cached: "cachedKb",
  SReclaimable: "sReclaimableKb",
  SwapTotal: "swapTotalKb",
  SwapFree: "swapFreeKb",
};

/** Parse `/proc/meminfo`; fields that are absent stay null. */
export function parseMeminfo(text: string): MeminfoSample {
  const sample: MeminfoSample = {
    memTotalKb: null,
    memFreeKb: null,
    memAvailableKb: null,
    cachedKb: null,
    sReclaimableKb: null,
    swapTotalKb: null,
    swapFreeKb: null,
  };
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z()_]+):\s+(\d+)\s*kB?\s*$/u.exec(line.trim());
    if (!match) continue;
    const key = MEMINFO_FIELDS[match[1] as string];
    if (key) sample[key] = Number(match[2]);
  }
  return sample;
}

export interface LoadSample {
  load1: number;
  load5: number;
  load15: number;
}

/** Parse `/proc/loadavg`; null when the shape is unrecognized. */
export function parseLoadAverages(text: string): LoadSample | null {
  const match = /^(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s/u.exec(text.trim());
  if (!match) return null;
  return { load1: Number(match[1]), load5: Number(match[2]), load15: Number(match[3]) };
}

/** Parse a cgroup v2 scalar file such as `memory.current`; "max" becomes null. */
export function parseCgroupScalar(text: string): number | null {
  const value = text.trim();
  if (value === "max") return null;
  return /^\d+$/u.test(value) ? Number(value) : null;
}

export interface CgroupMemoryEvents {
  oom: number;
  oomKill: number;
}

/** Parse cgroup v2 `memory.events`; missing counters read as zero. */
export function parseCgroupMemoryEvents(text: string): CgroupMemoryEvents {
  const events: CgroupMemoryEvents = { oom: 0, oomKill: 0 };
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+)\s+(\d+)\s*$/u.exec(line.trim());
    if (!match) continue;
    if (match[1] === "oom") events.oom = Number(match[2]);
    if (match[1] === "oom_kill") events.oomKill = Number(match[2]);
  }
  return events;
}

export interface PressureSample {
  someAvg10: number | null;
  someAvg60: number | null;
  fullAvg10: number | null;
  fullAvg60: number | null;
}

/** Parse a PSI file such as cgroup `memory.pressure` or `io.pressure`. */
export function parsePressure(text: string): PressureSample {
  const sample: PressureSample = {
    someAvg10: null,
    someAvg60: null,
    fullAvg10: null,
    fullAvg60: null,
  };
  for (const line of text.split("\n")) {
    const match = /^(some|full)\s+avg10=(\d+\.\d+)\s+avg60=(\d+\.\d+)\s/u.exec(line.trim());
    if (!match) continue;
    if (match[1] === "some") {
      sample.someAvg10 = Number(match[2]);
      sample.someAvg60 = Number(match[3]);
    } else {
      sample.fullAvg10 = Number(match[2]);
      sample.fullAvg60 = Number(match[3]);
    }
  }
  return sample;
}

export interface ProcessSample {
  comm: string;
  rssKb: number;
}

/**
 * Parse `ps -eo comm=,rss=` output into the top RSS consumers. Only the comm
 * name is retained — never argv — so command payloads and credentials in
 * process arguments cannot enter the evidence stream.
 */
export function parseTopProcesses(text: string, limit = TOP_PROCESS_LIMIT): ProcessSample[] {
  const rows: ProcessSample[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\S.*?)\s+(\d+)\s*$/u.exec(line.trim());
    if (!match) continue;
    rows.push({ comm: (match[1] as string).slice(0, COMM_MAX_LENGTH), rssKb: Number(match[2]) });
  }
  rows.sort((a, b) => b.rssKb - a.rssKb);
  return rows.slice(0, limit);
}

/** Parse a Docker CLI size such as "1.234GiB", "512MB", "75.5kB", or "0B". */
export function parseDockerSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/u.exec(value.trim());
  if (!match) return null;
  const magnitude = Number(match[1]);
  const unit = match[2] as string;
  const scale: Record<string, number> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    KiB: 1024,
    MB: 1000 ** 2,
    MiB: 1024 ** 2,
    GB: 1000 ** 3,
    GiB: 1024 ** 3,
    TB: 1000 ** 4,
    TiB: 1024 ** 4,
  };
  return Math.round(magnitude * (scale[unit] as number));
}

export interface ContainerStatSample {
  name: string;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
}

/**
 * Parse `docker stats --no-stream --format '{{json .}}'` lines. Malformed
 * lines are skipped; names are truncated to a bounded length.
 */
export function parseDockerStats(
  text: string,
  limit = CONTAINER_STAT_LIMIT,
): ContainerStatSample[] {
  const rows: ContainerStatSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.Name !== "string") continue;
    const memParts = typeof record.MemUsage === "string" ? record.MemUsage.split("/") : [];
    const cpuMatch =
      typeof record.CPUPerc === "string" ? /^(\d+(?:\.\d+)?)%$/u.exec(record.CPUPerc.trim()) : null;
    rows.push({
      name: record.Name.slice(0, CONTAINER_NAME_MAX_LENGTH),
      cpuPercent: cpuMatch ? Number(cpuMatch[1]) : null,
      memBytes: memParts[0] !== undefined ? parseDockerSize(memParts[0]) : null,
      memLimitBytes: memParts[1] !== undefined ? parseDockerSize(memParts[1]) : null,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export interface DockerDiskSample {
  imagesBytes: number | null;
  containersBytes: number | null;
  buildCacheBytes: number | null;
}

/** Parse `docker system df --format '{{json .}}'` lines. */
export function parseDockerSystemDf(text: string): DockerDiskSample {
  const sample: DockerDiskSample = {
    imagesBytes: null,
    containersBytes: null,
    buildCacheBytes: null,
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.Type !== "string" || typeof record.Size !== "string") continue;
    const bytes = parseDockerSize(record.Size);
    if (record.Type === "Images") sample.imagesBytes = bytes;
    if (record.Type === "Containers") sample.containersBytes = bytes;
    if (record.Type === "Build Cache") sample.buildCacheBytes = bytes;
  }
  return sample;
}

// ── Bounded, secret-safe snapshot line ───────────────────────────────────────

export interface DiskSample {
  freeBytes: number | null;
  totalBytes: number | null;
  inodesFree: number | null;
  inodesTotal: number | null;
}

export interface ResourceSnapshot {
  phase: string;
  at: string;
  meminfo: MeminfoSample | null;
  load: LoadSample | null;
  cgroup: {
    currentBytes: number | null;
    peakBytes: number | null;
    limitBytes: number | null;
    events: CgroupMemoryEvents | null;
  } | null;
  memoryPressure: PressureSample | null;
  ioPressure: PressureSample | null;
  topProcesses: ProcessSample[];
  containers: ContainerStatSample[];
  dockerDisk: DockerDiskSample | null;
  disk: DiskSample | null;
}

const PHASE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Validate a phase label before it enters argv or the evidence stream. The
 * shape mirrors the argv guards in the Brev lifecycle tooling: no leading
 * '-' (option injection) and no shell metacharacters.
 */
export function assertPhaseLabel(value: string | undefined): string {
  if (!value || !PHASE_LABEL_PATTERN.test(value)) {
    throw new Error("phase label must start alphanumeric and contain only [A-Za-z0-9._-]");
  }
  return value;
}

const number_ = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Serialize a snapshot to one bounded line. Every field is copied explicitly —
 * numbers, comm names, and container names only — so content outside the
 * allowlisted shape (environment values, command payloads, tokens) cannot be
 * emitted even if a collector is compromised or misbehaves. Lists are dropped
 * before scalars if the line would exceed the bound.
 */
export function renderSnapshotLine(snapshot: ResourceSnapshot): string {
  const build = (withLists: boolean): string => {
    const safe = {
      v: 1,
      phase: assertPhaseLabel(snapshot.phase),
      at: snapshot.at,
      meminfo:
        snapshot.meminfo === null
          ? null
          : {
              memTotalKb: number_(snapshot.meminfo.memTotalKb),
              memFreeKb: number_(snapshot.meminfo.memFreeKb),
              memAvailableKb: number_(snapshot.meminfo.memAvailableKb),
              cachedKb: number_(snapshot.meminfo.cachedKb),
              sReclaimableKb: number_(snapshot.meminfo.sReclaimableKb),
              swapTotalKb: number_(snapshot.meminfo.swapTotalKb),
              swapFreeKb: number_(snapshot.meminfo.swapFreeKb),
            },
      load:
        snapshot.load === null
          ? null
          : {
              load1: number_(snapshot.load.load1),
              load5: number_(snapshot.load.load5),
              load15: number_(snapshot.load.load15),
            },
      cgroup:
        snapshot.cgroup === null
          ? null
          : {
              currentBytes: number_(snapshot.cgroup.currentBytes),
              peakBytes: number_(snapshot.cgroup.peakBytes),
              limitBytes: number_(snapshot.cgroup.limitBytes),
              events:
                snapshot.cgroup.events === null
                  ? null
                  : {
                      oom: number_(snapshot.cgroup.events.oom),
                      oomKill: number_(snapshot.cgroup.events.oomKill),
                    },
            },
      memoryPressure: renderPressure(snapshot.memoryPressure),
      ioPressure: renderPressure(snapshot.ioPressure),
      topProcesses: withLists
        ? snapshot.topProcesses
            .slice(0, TOP_PROCESS_LIMIT)
            .map((p) => ({ comm: p.comm.slice(0, COMM_MAX_LENGTH), rssKb: number_(p.rssKb) }))
        : [],
      containers: withLists
        ? snapshot.containers.slice(0, CONTAINER_STAT_LIMIT).map((c) => ({
            name: c.name.slice(0, CONTAINER_NAME_MAX_LENGTH),
            cpuPercent: number_(c.cpuPercent),
            memBytes: number_(c.memBytes),
            memLimitBytes: number_(c.memLimitBytes),
          }))
        : [],
      dockerDisk:
        snapshot.dockerDisk === null
          ? null
          : {
              imagesBytes: number_(snapshot.dockerDisk.imagesBytes),
              containersBytes: number_(snapshot.dockerDisk.containersBytes),
              buildCacheBytes: number_(snapshot.dockerDisk.buildCacheBytes),
            },
      disk:
        snapshot.disk === null
          ? null
          : {
              freeBytes: number_(snapshot.disk.freeBytes),
              totalBytes: number_(snapshot.disk.totalBytes),
              inodesFree: number_(snapshot.disk.inodesFree),
              inodesTotal: number_(snapshot.disk.inodesTotal),
            },
    };
    return `${SNAPSHOT_LINE_PREFIX}${JSON.stringify(safe)}`;
  };
  const full = build(true);
  return full.length <= SNAPSHOT_LINE_MAX_LENGTH ? full : build(false);
}

function renderPressure(sample: PressureSample | null): PressureSample | null {
  if (sample === null) return null;
  return {
    someAvg10: number_(sample.someAvg10),
    someAvg60: number_(sample.someAvg60),
    fullAvg10: number_(sample.fullAvg10),
    fullAvg60: number_(sample.fullAvg60),
  };
}

// ── Terminal classification ──────────────────────────────────────────────────

export const TERMINAL_CLASSIFICATIONS = [
  "assertion",
  "timeout",
  "process-oom",
  "container-oom",
  "disk-pressure",
  "unknown",
] as const;

export type TerminalClassification = (typeof TERMINAL_CLASSIFICATIONS)[number];

export interface FailureEvidence {
  /** What the test harness itself reported for the failing run. */
  testOutcome: "assertion" | "timeout" | "none";
  /** cgroup `memory.events` oom_kill counter for the run's cgroup. */
  cgroupOomKills: number;
  /** Kernel OOM evidence where the hosted environment permits reading it. */
  kernelOomKilled: boolean;
  /** Docker `.State.OOMKilled` for the container under test, when known. */
  containerOomKilled: boolean;
  memFreeKb: number | null;
  memAvailableKb: number | null;
  diskFreeBytes: number | null;
  inodesFree: number | null;
}

export interface ClassifiedFailure {
  classification: TerminalClassification;
  reason: string;
}

/**
 * Classify an ordinary (non-runner-loss) failure from positive evidence only.
 * Low raw `MemFree` is never treated as OOM: page cache makes a healthy host
 * look exhausted, so OOM requires an actual kill counter or kernel/container
 * evidence.
 */
export function classifyFailure(evidence: FailureEvidence): ClassifiedFailure {
  if (evidence.testOutcome === "assertion") {
    return {
      classification: "assertion",
      reason: "the test harness reported an assertion failure; this is deterministic evidence",
    };
  }
  if (evidence.containerOomKilled) {
    return {
      classification: "container-oom",
      reason: "Docker reported OOMKilled=true for the container under test",
    };
  }
  if (evidence.cgroupOomKills > 0 || evidence.kernelOomKilled) {
    return {
      classification: "process-oom",
      reason:
        evidence.cgroupOomKills > 0
          ? `cgroup memory.events recorded ${evidence.cgroupOomKills} oom_kill event(s)`
          : "the kernel log recorded an OOM kill",
    };
  }
  if (
    (evidence.diskFreeBytes !== null && evidence.diskFreeBytes < MIN_DISK_FREE_BYTES) ||
    (evidence.inodesFree !== null && evidence.inodesFree < MIN_INODES_FREE)
  ) {
    return {
      classification: "disk-pressure",
      reason: "workspace free space or inode availability fell below the failure floor",
    };
  }
  if (evidence.testOutcome === "timeout") {
    return {
      classification: "timeout",
      reason: "the test harness reported a timeout without OOM or disk evidence",
    };
  }
  return {
    classification: "unknown",
    reason:
      "no positive OOM, disk, assertion, or timeout evidence; low raw MemFree alone is not OOM",
  };
}

/** Render the machine-readable classification line for logs and artifacts. */
export function renderClassificationLine(classified: ClassifiedFailure): string {
  return `${CLASSIFICATION_LINE_PREFIX}${JSON.stringify({
    v: 1,
    classification: classified.classification,
    reason: classified.reason,
  })}`;
}

// ── Runner-loss signature and retry policy ───────────────────────────────────

export interface WorkflowAttemptEvidence {
  /** True when the attempt uploaded/emitted a terminal classification. */
  terminalClassificationPresent: boolean;
  jobConclusion: "success" | "failure" | "cancelled";
  /** Count of runner-infrastructure loss markers observed by the workflow. */
  runnerLostMarkerCount: number;
}

/**
 * A hosted-runner loss requires a positive signature: the attempt produced no
 * terminal classification AND either the job was cancelled from outside or
 * runner-loss markers were observed. An attempt that produced a terminal
 * classification kept its runner long enough to classify — never runner loss.
 */
export function detectRunnerLoss(evidence: WorkflowAttemptEvidence): boolean {
  if (evidence.terminalClassificationPresent) return false;
  if (evidence.jobConclusion === "success") return false;
  return evidence.jobConclusion === "cancelled" || evidence.runnerLostMarkerCount > 0;
}

export interface RetryDecisionInput {
  runnerLoss: boolean;
  classification: TerminalClassification | null;
  /** 1-based attempt number of the attempt that just failed. */
  attempt: number;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
}

/**
 * At most one retry, and only for a confirmed hosted-runner-loss signature.
 * Assertions, deterministic failures, classified OOM, disk pressure, and
 * ambiguous failures receive zero automatic retries so broad retrying cannot
 * hide deterministic regressions.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  if (!input.runnerLoss) {
    const classification = input.classification ?? "unknown";
    return {
      retry: false,
      reason: `classification '${classification}' is never retried; only a confirmed hosted-runner loss is`,
    };
  }
  if (input.attempt > 1) {
    return {
      retry: false,
      reason: `attempt ${input.attempt} already consumed the single permitted runner-loss retry`,
    };
  }
  return {
    retry: true,
    reason:
      "confirmed hosted-runner loss on attempt 1; scheduling the single permitted retry and linking both attempts for diagnosis",
  };
}
