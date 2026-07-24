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
  sampleResources?: () => ResourceSnapshot;
  sampleResourceEvidence?: (phase: string) => string;
  resourceSampleIntervalMs?: number;
  recordResourceSample?: (phase: string, kind: ProgressResourceSampleKind) => boolean;
  recordResourceBaseline?: (phase: string) => void;
  terminalPhase?: string;
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
 * Unforgeable-by-structure capability proving that subprocess diagnostics are
 * backed by the shared E2E progress recorder.
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
  hasReached: (label: string) => boolean;
  isComplete: () => boolean;
  stop: (outcome?: ProgressPhaseOutcome) => void;
  summary: () => ProgressSummary;
  timeline: () => TestProgressTimeline;
}

export function isTestProgressCapability(value: unknown): value is TestProgress {
  if (typeof value !== "object" || value === null || !TEST_PROGRESS_INSTANCES.has(value)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, TEST_PROGRESS_CAPABILITY);
  return (
    Object.isFrozen(value) &&
    descriptor?.value === true &&
    descriptor.enumerable === false &&
    descriptor.configurable === false &&
    descriptor.writable === false
  );
}

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_STALL_REMINDER_INTERVAL_MS = 10 * 60_000;
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;
const GENERIC_PHASE_LABEL =
  /^(?:cleanup|execute|phase(?: \d+)?|run test|setup|teardown|test body|verify)$/iu;
const MAX_LOG_IDENTITY_LENGTH = 160;
const MAX_PHASE_LABEL_LENGTH = 160;
const MAX_ACTIVITY_LABEL_LENGTH = 160;
const MAX_EVENT_LABEL_LENGTH = 160;

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatElapsed(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function logIdentity(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LOG_IDENTITY_LENGTH);
  return JSON.stringify(normalized || fallback);
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

function formatResources(sampleResources: () => ResourceSnapshot): string {
  try {
    const snapshot = sampleResources();
    return [
      `rss ${formatGiB(snapshot.processRssBytes)}`,
      `memory ${snapshot.memoryAvailabilityKind ?? "available"} ` +
        `${formatGiB(snapshot.availableMemoryBytes)}/${formatGiB(snapshot.totalMemoryBytes)}`,
      `disk free ${formatGiB(snapshot.workspaceFreeBytes)}`,
      `load ${snapshot.loadAverage1m.toFixed(2)}`,
    ].join("; ");
  } catch {
    return "runner resources unavailable";
  }
}

export function validateE2EPhasePlan(phasePlan: readonly string[]): void {
  if (phasePlan.length < 2) {
    throw new Error("live E2E tests must declare at least two semantic phases");
  }
  if (phasePlan.length > 12) {
    throw new Error("live E2E tests must keep semantic phase plans to 12 phases or fewer");
  }

  const seen = new Set<string>();
  for (const label of phasePlan) {
    if (
      label !== label.trim() ||
      label.length === 0 ||
      label.length > MAX_PHASE_LABEL_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(label)
    ) {
      throw new Error("invalid live E2E phase label");
    }
    if (GENERIC_PHASE_LABEL.test(label) || label.toLowerCase().startsWith("command:")) {
      throw new Error(`live E2E phase label must describe test behavior: ${JSON.stringify(label)}`);
    }
    if (seen.has(label)) {
      throw new Error(`duplicate live E2E phase label: ${JSON.stringify(label)}`);
    }
    seen.add(label);
  }
}

/**
 * Reports semantic E2E phase transitions plus explicitly requested,
 * content-free status events. Child output is observed only as timestamps;
 * current command or cleanup activity becomes visible after a phase stalls.
 */
export function startTestProgress(
  scenario: string,
  phasePlan: readonly string[],
  options: TestProgressOptions = {},
): TestProgress {
  validateE2EPhasePlan(phasePlan);
  const terminalPhase = options.terminalPhase;
  if (terminalPhase) {
    if (phasePlan.includes(terminalPhase)) {
      throw new Error(`duplicate live E2E phase label: ${JSON.stringify(terminalPhase)}`);
    }
    validateE2EPhasePlan([phasePlan[0] as string, terminalPhase]);
  }
  const runtimePhasePlan = terminalPhase ? [...phasePlan, terminalPhase] : phasePlan;

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
  const identityPrefix =
    `[e2e target=${logIdentity(options.targetId ?? "", "unassigned")} ` +
    `scenario=${logIdentity(scenario, "unnamed")}]`;
  const phases: ProgressPhase[] = [];
  const reachedPhases = new Set<string>([runtimePhasePlan[0] as string]);
  const activities = new Map<number, string>();
  let nextActivityId = 0;
  let nextChildLifecycleOrdinal = 1;
  let phaseIndex = 0;
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

  const currentPhase = () => runtimePhasePlan[phaseIndex] as string;
  const phasePrefix = (index = phaseIndex) =>
    `${identityPrefix} [phase ${index + 1}/${runtimePhasePlan.length}]`;

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

  const logTransitionBestEffort = (atMs: number) => {
    try {
      logLine(
        `${phasePrefix()} started: ${currentPhase()} (` +
          `total ${formatElapsed(atMs - scenarioStartedAt)}; phase 0s)`,
      );
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const logCompletionBestEffort = (
    completedIndex: number,
    completedLabel: string,
    outcome: ProgressPhaseOutcome,
    durationMs: number,
    finishedAtMs: number,
  ) => {
    try {
      logLine(
        `${phasePrefix(completedIndex)} completed: ${completedLabel} — ` +
          `${outcome} in ${formatElapsed(durationMs)} ` +
          `(total ${formatElapsed(finishedAtMs - scenarioStartedAt)})`,
      );
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const logChildLifecycleBestEffort = (
    ordinal: number,
    checkpoint: "started" | ChildLifecycleOutcome,
  ) => {
    try {
      const current = now();
      logLine(
        `${phasePrefix()} child lifecycle ${ordinal}: ${checkpoint} (` +
          `total ${formatElapsed(current - scenarioStartedAt)}; ` +
          `phase ${formatElapsed(current - phaseStartedAt)})`,
      );
    } catch {
      // Diagnostics must not change child-process execution.
    }
  };

  const activityEvidence = (): string => {
    const active = [...activities.values()];
    if (active.length === 0) return "no active command";
    const latest = active.at(-1) as string;
    return active.length === 1
      ? `activity ${latest}`
      : `${active.length} active commands; latest ${latest}`;
  };

  const logStallBestEffort = () => {
    try {
      const current = now();
      const outputAge =
        lastOutputAt === null
          ? "no child output"
          : `child output ${formatElapsed(current - lastOutputAt)} ago`;
      logLine(
        `${phasePrefix()} still running: ${currentPhase()} (` +
          [
            `total ${formatElapsed(current - scenarioStartedAt)}`,
            `phase ${formatElapsed(current - phaseStartedAt)}`,
            outputAge,
            activityEvidence(),
            formatResources(sampleResources),
          ].join("; ") +
          ")",
      );
      if (!comparisonSamplingActive) {
        const evidence = sampleResourceEvidence?.(currentPhase());
        if (evidence) logLine(evidence);
      }
    } catch {
      // Diagnostics must not change the live test result.
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

  const finishPhase = (
    atMs: number,
    outcome: ProgressPhaseOutcome,
    options: { index?: number; startedAtMs?: number } = {},
  ): ProgressPhase => {
    const completed: ProgressPhase = {
      label: currentPhase(),
      outcome,
      startedAtMs: options.startedAtMs ?? phaseStartedAt,
      finishedAtMs: atMs,
      durationMs: Math.max(0, atMs - (options.startedAtMs ?? phaseStartedAt)),
      outputEvents: options.index === undefined ? outputEvents : 0,
      lastOutputAtMs: options.index === undefined ? lastOutputAt : null,
    };
    if (options.index !== undefined) completed.label = runtimePhasePlan[options.index] as string;
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
    const nextPhaseIndex = runtimePhasePlan.indexOf(label);
    if (nextPhaseIndex === -1) {
      throw new Error(`undeclared live E2E phase for ${scenario}: ${JSON.stringify(label)}`);
    }
    if (nextPhaseIndex < phaseIndex) {
      throw new Error(`live E2E phase moved backwards for ${scenario}: ${JSON.stringify(label)}`);
    }
    if (nextPhaseIndex === phaseIndex) return;

    const current = now();
    recordPhaseSampleBestEffort();
    const completedIndex = phaseIndex;
    const completedOutcome = outcomeAtBoundary("passed");
    const completed = finishPhase(current, completedOutcome);
    for (let skippedIndex = phaseIndex + 1; skippedIndex < nextPhaseIndex; skippedIndex += 1) {
      finishPhase(current, "skipped", {
        index: skippedIndex,
        startedAtMs: current,
      });
    }
    phaseIndex = nextPhaseIndex;
    reachedPhases.add(label);
    phaseStartedAt = current;
    lastOutputAt = null;
    outputEvents = 0;
    logCompletionBestEffort(
      completedIndex,
      completed.label,
      completed.outcome,
      completed.durationMs,
      current,
    );
    logTransitionBestEffort(current);
    recordBaselineBestEffort();
    resetStallDeadline(current);
  };

  recordBaselineBestEffort();
  logTransitionBestEffort(scenarioStartedAt);
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
      logChildLifecycleBestEffort(ordinal, "started");
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
        logChildLifecycleBestEffort(ordinal, outcome);
      };
      return Object.freeze(reportTerminal);
    },
    event(label) {
      if (finishedAt !== null) return;
      validateProgressEventLabel(label);
      const current = now();
      try {
        logLine(
          `${phasePrefix()} event: ${label} (` +
            `total ${formatElapsed(current - scenarioStartedAt)}; ` +
            `phase ${formatElapsed(current - phaseStartedAt)})`,
        );
      } catch {
        // Diagnostics must not change the live test result.
      }
    },
    phase: selectPhase,
    hasReached(label) {
      return reachedPhases.has(label);
    },
    isComplete() {
      return phaseIndex === runtimePhasePlan.length - 1;
    },
    stop(outcome = "passed") {
      if (finishedAt !== null) return;
      const stoppedAt = now();
      clearPulseTimer();
      recordPhaseSampleBestEffort();
      finishedAt = stoppedAt;
      const completed = finishPhase(finishedAt, outcomeAtBoundary(outcome));
      logCompletionBestEffort(
        phaseIndex,
        completed.label,
        completed.outcome,
        completed.durationMs,
        finishedAt,
      );
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

  Object.defineProperty(progress, TEST_PROGRESS_CAPABILITY, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  TEST_PROGRESS_INSTANCES.add(progress);
  return Object.freeze(progress);
}
