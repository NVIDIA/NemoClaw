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

const TOP_PROCESS_LIMIT = 5;
const CONTAINER_STAT_LIMIT = 5;
export const SNAPSHOT_LINE_PREFIX = "E2E_RESOURCE_SNAPSHOT ";
export const CLASSIFICATION_LINE_PREFIX = "E2E_TERMINAL_CLASSIFICATION ";
export const BASELINE_LINE_PREFIX = "E2E_RESOURCE_BASELINE ";
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
  rssKb: number;
}

/**
 * Parse `ps -eo rss=` output into the top RSS consumers. Process-controlled
 * names and argv are intentionally discarded so they cannot enter evidence.
 */
export function parseTopProcesses(text: string, limit = TOP_PROCESS_LIMIT): ProcessSample[] {
  const rows: ProcessSample[] = [];
  for (const line of text.split("\n")) {
    const match = /(?:^|\s)(\d+)\s*$/u.exec(line.trim());
    if (!match) continue;
    rows.push({ rssKb: Number(match[1]) });
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
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
}

/**
 * Parse `docker stats --no-stream --format '{{json .}}'` lines. Malformed
 * lines are skipped. Container-controlled names are intentionally discarded.
 * Rows are sorted before limiting so evidence reports the largest consumers.
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
    const memParts = typeof record.MemUsage === "string" ? record.MemUsage.split("/") : [];
    const cpuMatch =
      typeof record.CPUPerc === "string" ? /^(\d+(?:\.\d+)?)%$/u.exec(record.CPUPerc.trim()) : null;
    rows.push({
      cpuPercent: cpuMatch ? Number(cpuMatch[1]) : null,
      memBytes: memParts[0] !== undefined ? parseDockerSize(memParts[0]) : null,
      memLimitBytes: memParts[1] !== undefined ? parseDockerSize(memParts[1]) : null,
    });
  }
  rows.sort(
    (a, b) =>
      (b.memBytes ?? Number.NEGATIVE_INFINITY) - (a.memBytes ?? Number.NEGATIVE_INFINITY) ||
      (b.cpuPercent ?? Number.NEGATIVE_INFINITY) - (a.cpuPercent ?? Number.NEGATIVE_INFINITY),
  );
  return rows.slice(0, limit);
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
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

/** Accept only the fixed-width UTC representation produced by toISOString. */
export function assertCanonicalTimestamp(value: string | undefined): string {
  if (!value || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    throw new Error("snapshot timestamp must be a canonical UTC ISO-8601 value");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("snapshot timestamp must be a canonical UTC ISO-8601 value");
  }
  return value;
}

const number_ = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Serialize a snapshot to one bounded line. Every field is copied explicitly —
 * numbers and fixed rank values only — so content outside the
 * allowlisted shape (environment values, command payloads, tokens) cannot be
 * emitted even if a collector is compromised or misbehaves. Lists are dropped
 * before scalars if the line would exceed the bound.
 */
export function renderSnapshotLine(snapshot: ResourceSnapshot): string {
  const build = (withLists: boolean): string => {
    const safe = {
      v: 1,
      phase: assertPhaseLabel(snapshot.phase),
      at: assertCanonicalTimestamp(snapshot.at),
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
            .map((p, index) => ({ rank: index + 1, rssKb: number_(p.rssKb) }))
        : [],
      containers: withLists
        ? snapshot.containers.slice(0, CONTAINER_STAT_LIMIT).map((c, index) => ({
            rank: index + 1,
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

export interface ResourceBaseline {
  phase: string;
  at: string;
  cgroupOomKills: number;
  kernelOomKillCount: number;
  containerOomKilled: boolean;
}

function assertCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Count only explicit kernel OOM-kill records, never arbitrary diagnostics. */
export function countKernelOomKills(text: string): number {
  return text.match(/\bOut of memory:\s+Killed process\b/gu)?.length ?? 0;
}

/** Serialize the numeric/boolean pre-phase OOM baseline to a bounded line. */
export function renderBaselineLine(baseline: ResourceBaseline): string {
  return `${BASELINE_LINE_PREFIX}${JSON.stringify({
    v: 1,
    phase: assertPhaseLabel(baseline.phase),
    at: assertCanonicalTimestamp(baseline.at),
    cgroupOomKills: assertCounter(baseline.cgroupOomKills, "cgroupOomKills"),
    kernelOomKillCount: assertCounter(baseline.kernelOomKillCount, "kernelOomKillCount"),
    containerOomKilled: baseline.containerOomKilled === true,
  })}`;
}

/** Parse a baseline emitted by renderBaselineLine and reject all other shapes. */
export function parseBaselineLine(line: string): ResourceBaseline {
  const trimmed = line.trim();
  if (!trimmed.startsWith(BASELINE_LINE_PREFIX)) {
    throw new Error(`resource baseline must start with ${BASELINE_LINE_PREFIX.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(BASELINE_LINE_PREFIX.length));
  } catch {
    throw new Error("resource baseline must contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("resource baseline must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.containerOomKilled !== "boolean" ||
    Object.keys(record).sort().join(",") !==
      "at,cgroupOomKills,containerOomKilled,kernelOomKillCount,phase,v"
  ) {
    throw new Error("resource baseline has an unsupported shape");
  }
  return {
    phase: assertPhaseLabel(typeof record.phase === "string" ? record.phase : undefined),
    at: assertCanonicalTimestamp(typeof record.at === "string" ? record.at : undefined),
    cgroupOomKills: assertCounter(record.cgroupOomKills, "cgroupOomKills"),
    kernelOomKillCount: assertCounter(record.kernelOomKillCount, "kernelOomKillCount"),
    containerOomKilled: record.containerOomKilled,
  };
}

function baselineHasPositiveOomDelta(
  baseline: ResourceBaseline,
  current: ResourceBaseline,
): boolean {
  return (
    current.cgroupOomKills > baseline.cgroupOomKills ||
    current.kernelOomKillCount > baseline.kernelOomKillCount ||
    (!baseline.containerOomKilled && current.containerOomKilled)
  );
}

/**
 * Select the latest recorded phase that predates positive OOM evidence. A
 * cleanup phase sampled after the kill is intentionally skipped so it cannot
 * erase attribution to the phase that was active when the counter changed.
 */
export function selectFailureBaseline(
  initial: ResourceBaseline,
  phaseBaselines: readonly ResourceBaseline[],
  current: ResourceBaseline,
): ResourceBaseline {
  const initialAt = Date.parse(assertCanonicalTimestamp(initial.at));
  const currentAt = Date.parse(assertCanonicalTimestamp(current.at));
  if (
    currentAt < initialAt ||
    current.cgroupOomKills < initial.cgroupOomKills ||
    current.kernelOomKillCount < initial.kernelOomKillCount
  ) {
    throw new Error("current OOM evidence contradicts the workflow baseline");
  }
  let previousAt = initialAt;
  for (const baseline of phaseBaselines) {
    const baselineAt = Date.parse(assertCanonicalTimestamp(baseline.at));
    if (
      baselineAt < previousAt ||
      baselineAt > currentAt ||
      baseline.cgroupOomKills < initial.cgroupOomKills ||
      baseline.kernelOomKillCount < initial.kernelOomKillCount
    ) {
      throw new Error("phase baseline ledger is not monotonic from the workflow baseline");
    }
    previousAt = baselineAt;
  }
  for (let index = phaseBaselines.length - 1; index >= 0; index -= 1) {
    const candidate = phaseBaselines[index]!;
    if (baselineHasPositiveOomDelta(candidate, current)) return candidate;
  }
  return initial;
}

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
  /** Pre-phase and post-phase cgroup `memory.events` oom_kill counters. */
  cgroupOomKillsBefore: number;
  cgroupOomKillsAfter: number;
  /** Pre-phase and post-phase explicit kernel OOM-kill record counts. */
  kernelOomKillCountBefore: number;
  kernelOomKillCountAfter: number;
  /** Docker `.State.OOMKilled` before and after the phase, when known. */
  containerOomKilledBefore: boolean;
  containerOomKilledAfter: boolean;
  memFreeKb: number | null;
  memAvailableKb: number | null;
  diskFreeBytes: number | null;
  inodesFree: number | null;
}

export interface ClassifiedFailure {
  classification: TerminalClassification;
  reason: string;
}

const CLASSIFICATION_REASON_MAX_LENGTH = 512;

function assertClassificationReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > CLASSIFICATION_REASON_MAX_LENGTH ||
    /[^\x20-\x7e]/u.test(value)
  ) {
    throw new Error("classification reason must be bounded printable ASCII");
  }
  return value;
}

function positiveCounterDelta(before: number, after: number): number {
  if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0) {
    return 0;
  }
  return Math.max(0, after - before);
}

/**
 * Classify an ordinary (non-runner-loss) failure from positive evidence only.
 * Low raw `MemFree` is never treated as OOM: page cache makes a healthy host
 * look exhausted, so OOM requires an actual kill counter or kernel/container
 * evidence.
 */
export function classifyFailure(evidence: FailureEvidence): ClassifiedFailure {
  const cgroupOomKillDelta = positiveCounterDelta(
    evidence.cgroupOomKillsBefore,
    evidence.cgroupOomKillsAfter,
  );
  const kernelOomKillDelta = positiveCounterDelta(
    evidence.kernelOomKillCountBefore,
    evidence.kernelOomKillCountAfter,
  );
  if (evidence.testOutcome === "assertion") {
    return {
      classification: "assertion",
      reason: "the test harness reported an assertion failure; this is deterministic evidence",
    };
  }
  if (!evidence.containerOomKilledBefore && evidence.containerOomKilledAfter) {
    return {
      classification: "container-oom",
      reason: "Docker reported OOMKilled=true for the container under test",
    };
  }
  if (cgroupOomKillDelta > 0 || kernelOomKillDelta > 0) {
    return {
      classification: "process-oom",
      reason:
        cgroupOomKillDelta > 0
          ? `cgroup memory.events increased by ${cgroupOomKillDelta} oom_kill event(s) during the phase`
          : `the kernel log gained ${kernelOomKillDelta} OOM-kill record(s) during the phase`,
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
    reason: assertClassificationReason(classified.reason),
  })}`;
}

/** Parse one terminal line and reject missing, malformed, or extended shapes. */
export function parseClassificationLine(line: string): ClassifiedFailure {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CLASSIFICATION_LINE_PREFIX)) {
    throw new Error(`terminal classification must start with ${CLASSIFICATION_LINE_PREFIX.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(CLASSIFICATION_LINE_PREFIX.length));
  } catch {
    throw new Error("terminal classification must contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("terminal classification must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.classification !== "string" ||
    !TERMINAL_CLASSIFICATIONS.includes(record.classification as TerminalClassification) ||
    Object.keys(record).sort().join(",") !== "classification,reason,v"
  ) {
    throw new Error("terminal classification has an unsupported shape");
  }
  return {
    classification: record.classification as TerminalClassification,
    reason: assertClassificationReason(record.reason),
  };
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
 * A hosted-runner loss requires a positive trusted marker and no terminal
 * classification. Cancellation alone is not evidence because users and
 * concurrency controls can cancel healthy runners. An attempt that produced a
 * terminal classification kept its runner long enough to classify — never
 * runner loss.
 */
export function detectRunnerLoss(evidence: WorkflowAttemptEvidence): boolean {
  if (!Number.isSafeInteger(evidence.runnerLostMarkerCount) || evidence.runnerLostMarkerCount < 0) {
    throw new Error("runner-loss marker count must be a non-negative safe integer");
  }
  if (evidence.terminalClassificationPresent) return false;
  if (evidence.jobConclusion === "success") return false;
  return evidence.runnerLostMarkerCount > 0;
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
  if (input.classification !== null) {
    return {
      retry: false,
      reason: `classification '${input.classification}' is terminal and cannot be overridden by runner-loss evidence`,
    };
  }
  if (!input.runnerLoss) {
    return {
      retry: false,
      reason: "an unclassified failure is never retried; only a confirmed hosted-runner loss is",
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
