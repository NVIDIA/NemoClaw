// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PORTABLE_LIFECYCLE_TIMING_STAGES = [
  "authority",
  "inspect",
  "containerStart",
  "execReady",
  "ollama",
  "gatewayHealth",
  "startupProbe",
  "startupLaunch",
  "gatewayReady",
] as const;

export type PortableLifecycleTimingStage = (typeof PORTABLE_LIFECYCLE_TIMING_STAGES)[number];
export type PortableLifecycleTimingResult =
  | "not-installed"
  | "already-running"
  | "recovered"
  | "failed";
export type PortableLifecycleContainerAction = "unknown" | "reused" | "started";
export type PortableLifecycleGatewayAction = "unavailable" | "reused" | "waited" | "started";
export type PortableLifecycleOllamaAction =
  | "not-applicable"
  | "checking"
  | "reused"
  | "not-owned"
  | "start-attempted"
  | "started";
export type PortableLifecycleAttemptOutcome = "ready" | "not-ready" | "timeout" | "error";

export type PortableLifecycleTimingRecorder = {
  measure<T>(stage: PortableLifecycleTimingStage, operation: () => T): T;
  recordExecAttempt(outcome: PortableLifecycleAttemptOutcome): void;
  recordGatewayAttempt(outcome: PortableLifecycleAttemptOutcome): void;
  incrementOllamaAttempts(): void;
  setContainerAction(action: PortableLifecycleContainerAction): void;
  setGatewayAction(action: PortableLifecycleGatewayAction): void;
  setOllamaAction(action: PortableLifecycleOllamaAction): void;
  markFailureStage(stage: PortableLifecycleTimingStage): void;
  finish(result: PortableLifecycleTimingResult): void;
};

type PortableLifecycleTimingDeps = {
  now?: () => number;
  write?: (line: string) => void;
};

function safeElapsed(startedAt: number | null, finishedAt: number | null): number {
  if (startedAt === null || finishedAt === null) return 0;
  return Math.max(0, Math.round(finishedAt - startedAt));
}

type AttemptCounts = Record<PortableLifecycleAttemptOutcome, number>;

function createAttemptCounts(): AttemptCounts {
  return { ready: 0, "not-ready": 0, timeout: 0, error: 0 };
}

/**
 * Record one bounded, credential-free breakdown of Portable lifecycle recovery.
 * Diagnostic clock and writer failures are intentionally fail-open.
 */
export function createPortableLifecycleTimingRecorder(
  deps: PortableLifecycleTimingDeps = {},
): PortableLifecycleTimingRecorder {
  const now = deps.now ?? (() => performance.now());
  const write = deps.write ?? ((line: string) => console.log(line));
  const durations = new Map<PortableLifecycleTimingStage, number>();
  let containerAction: PortableLifecycleContainerAction = "unknown";
  let gatewayAction: PortableLifecycleGatewayAction = "unavailable";
  let ollamaAction: PortableLifecycleOllamaAction = "not-applicable";
  let ollamaAttempts = 0;
  const execAttempts = createAttemptCounts();
  const gatewayAttempts = createAttemptCounts();
  let failureStage: PortableLifecycleTimingStage | null = null;
  let finished = false;

  const safeNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const totalStartedAt = safeNow();

  const finish = (result: PortableLifecycleTimingResult): void => {
    if (finished) return;
    finished = true;
    try {
      const stageFields = PORTABLE_LIFECYCLE_TIMING_STAGES.map(
        (stage) => `${stage}=${String(durations.get(stage) ?? 0)}ms`,
      );
      const failure = result === "failed" ? ` failedStage=${failureStage ?? "unknown"}` : "";
      const execTotal = Object.values(execAttempts).reduce((total, count) => total + count, 0);
      const gatewayTotal = Object.values(gatewayAttempts).reduce(
        (total, count) => total + count,
        0,
      );
      write(
        `  Portable lifecycle timing: ${stageFields.join(" ")} total=${String(safeElapsed(totalStartedAt, safeNow()))}ms containerAction=${containerAction} gatewayAction=${gatewayAction} ollamaAction=${ollamaAction} ollamaAttempts=${String(ollamaAttempts)} execAttempts=${String(execTotal)} execNotReady=${String(execAttempts["not-ready"])} execTimeouts=${String(execAttempts.timeout)} execErrors=${String(execAttempts.error)} gatewayAttempts=${String(gatewayTotal)} gatewayNotReady=${String(gatewayAttempts["not-ready"])} gatewayTimeouts=${String(gatewayAttempts.timeout)} gatewayErrors=${String(gatewayAttempts.error)} result=${result}${failure}`,
      );
    } catch {
      // Lifecycle timing must never change recovery status or its original error.
    }
  };

  const measure = <T>(stage: PortableLifecycleTimingStage, operation: () => T): T => {
    const startedAt = safeNow();
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      failureStage ??= stage;
      throw error;
    } finally {
      const elapsed = safeElapsed(startedAt, safeNow());
      durations.set(stage, (durations.get(stage) ?? 0) + elapsed);
      if (failed) finish("failed");
    }
  };

  return {
    measure,
    recordExecAttempt(outcome: PortableLifecycleAttemptOutcome): void {
      execAttempts[outcome] += 1;
    },
    recordGatewayAttempt(outcome: PortableLifecycleAttemptOutcome): void {
      gatewayAttempts[outcome] += 1;
    },
    incrementOllamaAttempts(): void {
      ollamaAttempts += 1;
    },
    setContainerAction(action: PortableLifecycleContainerAction): void {
      containerAction = action;
    },
    setGatewayAction(action: PortableLifecycleGatewayAction): void {
      gatewayAction = action;
    },
    setOllamaAction(action: PortableLifecycleOllamaAction): void {
      ollamaAction = action;
    },
    markFailureStage(stage: PortableLifecycleTimingStage): void {
      failureStage ??= stage;
    },
    finish,
  };
}
