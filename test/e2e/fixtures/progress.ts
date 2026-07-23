// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";

import { REPO_ROOT } from "./paths.ts";
import type { ShellProbeOutputEvent } from "./shell-probe.ts";

interface ResourceSnapshot {
  freeMemoryBytes: number;
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
  stallThresholdMs?: number;
  stallReminderIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logLine?: (line: string) => void;
  sampleResources?: () => ResourceSnapshot;
  sampleResourceEvidence?: (phase: string) => string;
  recordResourceBaseline?: (phase: string) => void;
  terminalPhase?: string;
  taskStatus?: () => { errorCount: number; outcome?: ProgressPhaseOutcome };
}

export interface TestProgressTimeline {
  phases: ReadonlyArray<{ label: string; elapsedMs: number }>;
  totalMs: number;
}

export type ProgressPhaseOutcome = "passed" | "failed" | "skipped";

export interface TestProgress {
  onOutput: (event: ShellProbeOutputEvent) => void;
  activity: (label: string) => () => void;
  phase: (label: string) => void;
  isComplete: () => boolean;
  stop: (outcome?: ProgressPhaseOutcome) => void;
  summary: () => ProgressSummary;
  timeline: () => TestProgressTimeline;
}

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_STALL_REMINDER_INTERVAL_MS = 10 * 60_000;
const GENERIC_PHASE_LABEL =
  /^(?:cleanup|execute|phase(?: \d+)?|run test|setup|teardown|test body|verify)$/iu;

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

function defaultResourceSnapshot(): ResourceSnapshot {
  const workspace = fs.statfsSync(REPO_ROOT);
  return {
    freeMemoryBytes: os.freemem(),
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
      `memory free ${formatGiB(snapshot.freeMemoryBytes)}/${formatGiB(snapshot.totalMemoryBytes)}`,
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
    if (label !== label.trim() || label.length === 0) {
      throw new Error(`invalid live E2E phase label: ${JSON.stringify(label)}`);
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
 * Reports only semantic E2E phase transitions during normal execution. Child
 * output and command activity are observed without forwarding their contents;
 * they become visible only as content-free evidence after a phase is stalled.
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
  const recordResourceBaseline = options.recordResourceBaseline;
  const taskStatus = options.taskStatus;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const stallReminderIntervalMs =
    options.stallReminderIntervalMs ?? DEFAULT_STALL_REMINDER_INTERVAL_MS;
  const scenarioStartedAt = now();
  const phases: ProgressPhase[] = [];
  const activities = new Map<number, string>();
  let nextActivityId = 0;
  let phaseIndex = 0;
  let phaseStartedAt = scenarioStartedAt;
  let lastOutputAt: number | null = null;
  let outputEvents = 0;
  let finishedAt: number | null = null;
  let stallTimer: TimerHandle | null = null;
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
  const phasePrefix = () => `[e2e phase ${phaseIndex + 1}/${runtimePhasePlan.length}]`;

  const recordBaselineBestEffort = () => {
    try {
      recordResourceBaseline?.(currentPhase());
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const logTransitionBestEffort = () => {
    try {
      logLine(`${phasePrefix()} ${currentPhase()}`);
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const logCompletionBestEffort = (
    completedIndex: number,
    completedLabel: string,
    outcome: ProgressPhaseOutcome,
    durationMs: number,
    next?: { index: number; label: string },
  ) => {
    try {
      const nextText = next
        ? `; next ${next.index + 1}/${runtimePhasePlan.length}: ${next.label}`
        : "";
      logLine(
        `[e2e phase ${completedIndex + 1}/${runtimePhasePlan.length}] ${completedLabel} — ` +
          `${outcome} in ${formatElapsed(durationMs)}${nextText}`,
      );
    } catch {
      // Diagnostics must not change the live test result.
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
            `phase ${formatElapsed(current - phaseStartedAt)}`,
            outputAge,
            activityEvidence(),
            formatResources(sampleResources),
          ].join("; ") +
          ")",
      );
      const evidence = sampleResourceEvidence?.(currentPhase());
      if (evidence) logLine(evidence);
    } catch {
      // Diagnostics must not change the live test result.
    }
  };

  const clearStallTimer = () => {
    if (stallTimer === null) return;
    clearTimer(stallTimer);
    stallTimer = null;
  };

  const scheduleStall = (delayMs: number) => {
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (finishedAt !== null) return;
      logStallBestEffort();
      scheduleStall(stallReminderIntervalMs);
    }, delayMs);
    stallTimer.unref?.();
  };

  const resetStallTimer = () => {
    clearStallTimer();
    scheduleStall(stallThresholdMs);
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
    phaseStartedAt = current;
    lastOutputAt = null;
    outputEvents = 0;
    logCompletionBestEffort(
      completedIndex,
      completed.label,
      completed.outcome,
      completed.durationMs,
      {
        index: phaseIndex,
        label: currentPhase(),
      },
    );
    recordBaselineBestEffort();
    resetStallTimer();
  };

  recordBaselineBestEffort();
  logTransitionBestEffort();
  scheduleStall(stallThresholdMs);

  const progress: TestProgress = {
    onOutput(event) {
      if (finishedAt !== null) return;
      lastOutputAt = event.atMs;
      outputEvents += 1;
    },
    activity(label) {
      if (finishedAt !== null) return () => undefined;
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
    phase: selectPhase,
    isComplete() {
      return phaseIndex === runtimePhasePlan.length - 1;
    },
    stop(outcome = "passed") {
      if (finishedAt !== null) return;
      finishedAt = now();
      clearStallTimer();
      const completed = finishPhase(finishedAt, outcomeAtBoundary(outcome));
      logCompletionBestEffort(phaseIndex, completed.label, completed.outcome, completed.durationMs);
      activities.clear();
    },
    summary() {
      return {
        version: 1,
        scenario,
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

  return progress;
}
