// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { REPO_ROOT } from "./paths.ts";
import type { ShellProbeOutputEvent } from "./shell-probe.ts";

interface ResourceSnapshot {
  availableMemoryBytes: number;
  memoryAvailabilityKind?: "available" | "free";
  processRssBytes: number;
  totalMemoryBytes: number;
  workspaceFreeBytes: number;
  loadAverage1m: number;
}

interface TimerHandle {
  unref?: () => void;
}

export interface ProgressPhase {
  label: string;
  outcome: ProgressPhaseOutcome;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  outputEvents: number;
  lastOutputAtMs: number | null;
}

export interface ProgressSummary {
  version: 1;
  scenario: string;
  targetId?: string;
  shardId?: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  phases: readonly ProgressPhase[];
}

export interface TestProgressOptions {
  targetId?: string;
  stallThresholdMs?: number;
  stallReminderIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logLine?: (line: string) => void;
  redact?: (text: string) => string;
  sampleResources?: () => ResourceSnapshot;
  sampleResourceEvidence?: (phase: string) => string;
  resourceSampleIntervalMs?: number;
  recordResourceSample?: (phase: string, kind: ProgressResourceSampleKind) => boolean;
  recordResourceBaseline?: (phase: string) => void;
  taskStatus?: () => { errorCount: number; outcome?: ProgressPhaseOutcome };
}

export interface TestProgressTimeline {
  phases: ReadonlyArray<{ label: string; elapsedMs: number }>;
  totalMs: number;
}

export type ProgressPhaseOutcome = "passed" | "failed" | "skipped";
export type ProgressResourceSampleKind = "periodic" | "scenario-start" | "phase";

export type ChildLifecycleOutcome =
  | "spawn-failed"
  | "exited-zero"
  | "exited-nonzero"
  | "signaled"
  | "closed-unknown";

export type ChildLifecycleTerminalReporter = (outcome: ChildLifecycleOutcome) => void;

const TEST_PROGRESS_CAPABILITY: unique symbol = Symbol("nemoclaw.test-progress");
const TEST_PROGRESS_INSTANCES = new WeakSet<object>();

/**
 * Requires callers to forward the fixture monitor instead of supplying a look-alike.
 */
export interface TestProgressCapability {
  readonly [TEST_PROGRESS_CAPABILITY]: true;
}

export interface TestProgress extends TestProgressCapability {
  onOutput: (event: ShellProbeOutputEvent) => void;
  activity: (label: string) => () => void;
  beginChildLifecycle: () => ChildLifecycleTerminalReporter;
  /** Emit a content-free semantic status event. Never pass child output or request data. */
  event: (label: string) => void;
  phase: (label: string) => void;
  stop: (outcome?: ProgressPhaseOutcome) => void;
  summary: () => ProgressSummary;
  timeline: () => TestProgressTimeline;
}

export function isTestProgressCapability(value: unknown): value is TestProgress {
  return typeof value === "object" && value !== null && TEST_PROGRESS_INSTANCES.has(value);
}

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_STALL_REMINDER_INTERVAL_MS = 10 * 60_000;
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;
const MAX_LOG_IDENTITY_LENGTH = 160;
const MAX_ACTIVITY_LABEL_LENGTH = 160;
const MAX_EVENT_LABEL_LENGTH = 160;

function logIdentity(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LOG_IDENTITY_LENGTH);
  return normalized || fallback;
}

function validateProgressEventLabel(label: string): void {
  if (label !== label.trim() || label.length === 0 || label.length > MAX_EVENT_LABEL_LENGTH) {
    throw new Error("invalid live E2E progress event label");
  }
  if (/[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("invalid live E2E progress event label");
  }
}

function validateProgressActivityLabel(label: string): void {
  if (label !== label.trim() || label.length === 0 || label.length > MAX_ACTIVITY_LABEL_LENGTH) {
    throw new Error("invalid live E2E progress activity label");
  }
  if (/[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("invalid live E2E progress activity label");
  }
}

function defaultResourceSnapshot(): ResourceSnapshot {
  const workspace = fs.statfsSync(REPO_ROOT);
  let availableMemoryBytes = os.freemem();
  let memoryAvailabilityKind: "available" | "free" = "free";
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/mu.exec(
      fs.readFileSync("/proc/meminfo", "utf8"),
    );
    const kilobytes = match ? Number(match[1]) : Number.NaN;
    const bytes = kilobytes * 1024;
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      availableMemoryBytes = bytes;
      memoryAvailabilityKind = "available";
    }
  } catch {
    // Non-Linux and restricted hosts fall back to the portable free-memory value.
  }
  return {
    availableMemoryBytes,
    memoryAvailabilityKind,
    processRssBytes: process.memoryUsage().rss,
    totalMemoryBytes: os.totalmem(),
    workspaceFreeBytes: workspace.bavail * workspace.bsize,
    loadAverage1m: os.loadavg()[0] ?? 0,
  };
}

/**
 * Logs observed activities and records timings for runtime reports.
 * Child output is observed only as timestamps; stalled activities include runner resources.
 */
export function startTestProgress(
  scenario: string,
  initialPhase: string,
  options: TestProgressOptions = {},
): TestProgress {
  validateProgressEventLabel(initialPhase);

  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const logLine = options.logLine ?? ((line) => process.stdout.write(`${line}\n`));
  const sampleResources = options.sampleResources ?? defaultResourceSnapshot;
  const sampleResourceEvidence = options.sampleResourceEvidence;
  const recordResourceSample = options.recordResourceSample;
  const recordResourceBaseline = options.recordResourceBaseline;
  const taskStatus = options.taskStatus;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const stallReminderIntervalMs =
    options.stallReminderIntervalMs ?? DEFAULT_STALL_REMINDER_INTERVAL_MS;
  const resourceSampleIntervalMs =
    options.resourceSampleIntervalMs ?? DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS;
  if (
    recordResourceSample &&
    (!Number.isSafeInteger(resourceSampleIntervalMs) || resourceSampleIntervalMs < 1)
  ) {
    throw new Error("resource sample interval must be a positive safe integer");
  }
  const scenarioStartedAt = now();
  const identity = {
    target: logIdentity(options.targetId ?? "", "unassigned"),
    scenario: logIdentity(scenario, "unnamed"),
  };
  const phases: ProgressPhase[] = [];
  let phaseLabel = initialPhase;
  const activities = new Map<number, string>();
  let nextActivityId = 0;
  let nextChildLifecycleOrdinal = 1;
  let phaseStartedAt = scenarioStartedAt;
  let lastOutputAt: number | null = null;
  let outputEvents = 0;
  let finishedAt: number | null = null;
  let pulseTimer: TimerHandle | null = null;
  let pulseGeneration = 0;
  let comparisonSamplingActive = recordResourceSample !== undefined;
  let nextPeriodicAtMs: number | null = null;
  let nextStallAtMs = scenarioStartedAt + stallThresholdMs;
  let attributedFailure = false;
  let attributedSkip = false;

  const readTaskStatus = (): { errorCount: number; outcome?: ProgressPhaseOutcome } => {
    try {
      const status = taskStatus?.();
      return {
        errorCount:
          status && Number.isSafeInteger(status.errorCount) && status.errorCount >= 0
            ? status.errorCount
            : 0,
        ...(status?.outcome ? { outcome: status.outcome } : {}),
      };
    } catch {
      return { errorCount: 0 };
    }
  };
  let phaseStartErrorCount = readTaskStatus().errorCount;

  const currentPhase = () => phaseLabel;

  const recordBaselineBestEffort = () => {
    try {
      recordResourceBaseline?.(currentPhase());
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const disableComparisonSampling = () => {
    comparisonSamplingActive = false;
    nextPeriodicAtMs = null;
  };

  const recordSampleBestEffort = (kind: ProgressResourceSampleKind): boolean => {
    if (!comparisonSamplingActive || !recordResourceSample) return false;
    try {
      if (!recordResourceSample(currentPhase(), kind)) {
        disableComparisonSampling();
        return false;
      }
      return true;
    } catch {
      disableComparisonSampling();
      return false;
    }
  };

  const advanceDeadline = (deadlineMs: number, intervalMs: number, currentMs: number): number => {
    const elapsedIntervals = Math.floor(Math.max(0, currentMs - deadlineMs) / intervalMs) + 1;
    return deadlineMs + elapsedIntervals * intervalMs;
  };

  const consumePeriodicDeadline = (currentMs: number) => {
    if (nextPeriodicAtMs === null || currentMs < nextPeriodicAtMs) return;
    nextPeriodicAtMs = advanceDeadline(nextPeriodicAtMs, resourceSampleIntervalMs, currentMs);
  };

  const recordPhaseSampleBestEffort = () => {
    recordSampleBestEffort("phase");
    if (comparisonSamplingActive) consumePeriodicDeadline(now());
  };

  const writeLog = (event: string, atMs: number, details: Record<string, unknown> = {}) => {
    try {
      logLine(
        JSON.stringify(
          {
            kind: "e2e-progress",
            ...identity,
            event,
            activity: currentPhase(),
            elapsedMs: Math.max(0, atMs - scenarioStartedAt),
            activityElapsedMs: Math.max(0, atMs - phaseStartedAt),
            ...details,
          },
          (_key, value: unknown) =>
            typeof value === "string" ? (options.redact?.(value) ?? value) : value,
        ),
      );
    } catch {
      // Diagnostics must not change execution or cleanup.
    }
  };

  const logStallBestEffort = () => {
    const current = now();
    let resources: ResourceSnapshot | null = null;
    try {
      resources = sampleResources();
    } catch {
      /* Resource probes are diagnostic-only. */
    }
    writeLog("stall", current, {
      outputAgeMs: lastOutputAt === null ? null : Math.max(0, current - lastOutputAt),
      activeCommands: [...activities.values()],
      resources,
    });
    if (!comparisonSamplingActive) {
      try {
        const evidence = sampleResourceEvidence?.(currentPhase());
        if (evidence) logLine(evidence);
      } catch {
        /* Resource evidence must not change execution. */
      }
    }
  };

  const clearPulseTimer = (): boolean => {
    pulseGeneration += 1;
    if (pulseTimer === null) return true;
    const timer = pulseTimer;
    try {
      clearTimer(timer);
      pulseTimer = null;
      return true;
    } catch {
      // The generation guard still makes an uncleared callback harmless.
      return false;
    }
  };

  const schedulePulse = (currentMs = now()) => {
    if (finishedAt !== null) return;
    const deadlines = [nextStallAtMs, ...(nextPeriodicAtMs === null ? [] : [nextPeriodicAtMs])];
    const delayMs = Math.max(0, Math.min(...deadlines) - currentMs);
    const generation = pulseGeneration + 1;
    pulseGeneration = generation;
    let scheduledTimer: TimerHandle | null = null;
    try {
      scheduledTimer = setTimer(() => {
        if (generation !== pulseGeneration) {
          if (pulseTimer === scheduledTimer) {
            pulseTimer = null;
            schedulePulse();
          }
          return;
        }
        pulseTimer = null;
        if (finishedAt !== null) return;
        let current = now();
        if (nextPeriodicAtMs !== null && current >= nextPeriodicAtMs) {
          recordSampleBestEffort("periodic");
          current = now();
          if (comparisonSamplingActive) consumePeriodicDeadline(current);
        }
        if (current >= nextStallAtMs) {
          logStallBestEffort();
          current = now();
          nextStallAtMs = advanceDeadline(nextStallAtMs, stallReminderIntervalMs, current);
        }
        schedulePulse(current);
      }, delayMs);
      pulseTimer = scheduledTimer;
      try {
        pulseTimer.unref?.();
      } catch {
        // Timer liveness hints are diagnostic-only.
      }
    } catch {
      pulseTimer = null;
    }
  };

  const resetStallDeadline = (currentMs: number) => {
    const cleared = clearPulseTimer();
    nextStallAtMs = currentMs + stallThresholdMs;
    if (cleared) schedulePulse();
  };

  const finishPhase = (atMs: number, outcome: ProgressPhaseOutcome): ProgressPhase => {
    const completed: ProgressPhase = {
      label: currentPhase(),
      outcome,
      startedAtMs: phaseStartedAt,
      finishedAtMs: atMs,
      durationMs: Math.max(0, atMs - phaseStartedAt),
      outputEvents,
      lastOutputAtMs: lastOutputAt,
    };
    phases.push(completed);
    return completed;
  };

  const outcomeAtBoundary = (fallback: ProgressPhaseOutcome): ProgressPhaseOutcome => {
    const status = readTaskStatus();
    const hasNewErrors = status.errorCount > phaseStartErrorCount;
    phaseStartErrorCount = Math.max(phaseStartErrorCount, status.errorCount);
    if (hasNewErrors) {
      attributedFailure = true;
      return "failed";
    }
    if (status.outcome === "failed" && !attributedFailure) {
      attributedFailure = true;
      return "failed";
    }
    if (status.outcome === "skipped" && !attributedSkip) {
      attributedSkip = true;
      return "skipped";
    }
    if (fallback === "failed" && !attributedFailure) {
      attributedFailure = true;
      return "failed";
    }
    if (fallback === "skipped" && !attributedSkip) {
      attributedSkip = true;
      return "skipped";
    }
    return "passed";
  };

  const selectPhase = (label: string) => {
    if (finishedAt !== null) return;
    validateProgressEventLabel(label);
    if (label === phaseLabel) return;

    const current = now();
    recordPhaseSampleBestEffort();
    const completedOutcome = outcomeAtBoundary("passed");
    const completed = finishPhase(current, completedOutcome);
    writeLog("complete", current, { outcome: completed.outcome, durationMs: completed.durationMs });
    phaseLabel = label;
    phaseStartedAt = current;
    lastOutputAt = null;
    outputEvents = 0;
    writeLog("start", current);
    recordBaselineBestEffort();
    resetStallDeadline(current);
  };

  recordBaselineBestEffort();
  writeLog("start", scenarioStartedAt);
  recordSampleBestEffort("scenario-start");
  if (comparisonSamplingActive) {
    nextPeriodicAtMs = scenarioStartedAt + resourceSampleIntervalMs;
  }
  schedulePulse(recordResourceSample ? now() : scenarioStartedAt);

  const progress: TestProgress = {
    [TEST_PROGRESS_CAPABILITY]: true,
    onOutput(event) {
      if (finishedAt !== null) return;
      lastOutputAt = event.atMs;
      outputEvents += 1;
    },
    activity(label) {
      if (finishedAt !== null) return () => undefined;
      validateProgressActivityLabel(label);
      const activityId = nextActivityId;
      nextActivityId += 1;
      activities.set(activityId, label);
      let activityFinished = false;
      return () => {
        if (activityFinished) return;
        activityFinished = true;
        activities.delete(activityId);
      };
    },
    beginChildLifecycle() {
      if (finishedAt !== null) {
        return Object.freeze((_outcome: ChildLifecycleOutcome) => undefined);
      }
      const ordinal = nextChildLifecycleOrdinal;
      nextChildLifecycleOrdinal += 1;
      writeLog("child", now(), { child: ordinal, outcome: "started" });
      let terminalReported = false;
      const reportTerminal: ChildLifecycleTerminalReporter = (outcome) => {
        if (terminalReported) return;
        switch (outcome) {
          case "spawn-failed":
          case "exited-zero":
          case "exited-nonzero":
          case "signaled":
          case "closed-unknown":
            break;
          default:
            return;
        }
        terminalReported = true;
        writeLog("child", now(), { child: ordinal, outcome });
      };
      return Object.freeze(reportTerminal);
    },
    event(label) {
      if (finishedAt !== null) return;
      validateProgressEventLabel(label);
      writeLog("message", now(), { message: label });
    },
    phase: selectPhase,
    stop(outcome = "passed") {
      if (finishedAt !== null) return;
      const stoppedAt = now();
      clearPulseTimer();
      recordPhaseSampleBestEffort();
      finishedAt = stoppedAt;
      const completed = finishPhase(finishedAt, outcomeAtBoundary(outcome));
      writeLog("complete", finishedAt, {
        outcome: completed.outcome,
        durationMs: completed.durationMs,
      });
      activities.clear();
    },
    summary() {
      return {
        version: 1,
        scenario,
        ...(options.targetId ? { targetId: options.targetId } : {}),
        startedAtMs: scenarioStartedAt,
        finishedAtMs: finishedAt,
        durationMs: finishedAt === null ? null : Math.max(0, finishedAt - scenarioStartedAt),
        phases: phases.map((phase) => ({ ...phase })),
      };
    },
    timeline() {
      const current = now();
      return {
        phases:
          finishedAt === null
            ? [
                ...phases.map((phase) => ({
                  label: phase.label,
                  elapsedMs: phase.durationMs,
                })),
                {
                  label: currentPhase(),
                  elapsedMs: Math.max(0, current - phaseStartedAt),
                },
              ]
            : phases.map((phase) => ({
                label: phase.label,
                elapsedMs: phase.durationMs,
              })),
        totalMs: Math.max(0, (finishedAt ?? current) - scenarioStartedAt),
      };
    },
  };

  TEST_PROGRESS_INSTANCES.add(progress);
  return Object.freeze(progress);
}
