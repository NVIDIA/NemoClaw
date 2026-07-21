// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

export interface RebuildHermesTimingPhase {
  label: string;
  elapsedMs: number;
}

export interface RebuildHermesTimeline {
  phases: readonly RebuildHermesTimingPhase[];
  totalMs: number;
}

export interface RebuildHermesRunnerClass {
  platform: string;
  arch: string;
  cpuCount: number;
  cpuModel: string;
  totalMemoryBytes: number;
}

export type RebuildHermesLane = "normal" | "stale-base";

export interface RebuildHermesTimingSummary {
  schema: 1;
  lane: RebuildHermesLane;
  runnerClass: RebuildHermesRunnerClass;
  phases: RebuildHermesTimingPhase[];
  totalMs: number;
  capturedAtIso: string;
}

interface RunnerClassSample {
  platform: string;
  arch: string;
  cpus: ReadonlyArray<{ model: string }>;
  totalMemoryBytes: number;
}

function defaultRunnerClassSample(): RunnerClassSample {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().map((cpu) => ({ model: cpu.model })),
    totalMemoryBytes: os.totalmem(),
  };
}

/**
 * Fingerprint the runner so before/after timings can be confirmed to come from
 * the same runner class before any comparison. The comparison itself lives with
 * whoever reads the artifacts; this only records the identifying fields.
 */
export function describeRunnerClass(
  sample: () => RunnerClassSample = defaultRunnerClassSample,
): RebuildHermesRunnerClass {
  const snapshot = sample();
  return {
    platform: snapshot.platform,
    arch: snapshot.arch,
    cpuCount: snapshot.cpus.length,
    cpuModel: snapshot.cpus[0]?.model.trim() || "unknown",
    totalMemoryBytes: snapshot.totalMemoryBytes,
  };
}

function normalizeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export interface BuildRebuildHermesTimingSummaryInput {
  lane: RebuildHermesLane;
  timeline: RebuildHermesTimeline;
  runnerClass: RebuildHermesRunnerClass;
  capturedAtIso: string;
}

/**
 * Shape the recorded timeline into the stable timing artifact. Durations are
 * normalized to non-negative whole milliseconds so repeated runs on the same
 * runner class stay directly comparable.
 */
export function buildRebuildHermesTimingSummary(
  input: BuildRebuildHermesTimingSummaryInput,
): RebuildHermesTimingSummary {
  return {
    schema: 1,
    lane: input.lane,
    runnerClass: input.runnerClass,
    phases: input.timeline.phases.map((phase) => ({
      label: phase.label,
      elapsedMs: normalizeMs(phase.elapsedMs),
    })),
    totalMs: normalizeMs(input.timeline.totalMs),
    capturedAtIso: input.capturedAtIso,
  };
}
