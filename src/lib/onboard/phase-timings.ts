// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process registry of onboarding phase timings.
 *
 * The onboarding flow runs through several sequence phases (gateway startup,
 * sandbox creation, inference setup, agent setup, finalization). Some of those
 * phases block on non-interactive waits that can run for minutes with no
 * output. `phase-progress` records how long each phase took here so the flow
 * can print a single "Phase timings" summary to the user at the end and give
 * an actionable picture of where the wall-clock went (#6002).
 *
 * State is module-level on purpose: the three onboarding sequence runs
 * (initial / core / final) each build their own handlers but share this one
 * process, so a shared registry is what lets the final summary span all of
 * them without threading a collector through `onboard.ts` (which is held
 * net-neutral by a codebase-growth guardrail).
 */

export type PhaseTimingStatus = "completed" | "failed";

export interface PhaseTiming {
  /** FSM state name for the phase (e.g. "gateway", "sandbox"). */
  phase: string;
  /** Human-friendly label shown to the user. */
  label: string;
  /** Wall-clock duration of the phase in milliseconds. */
  durationMs: number;
  status: PhaseTimingStatus;
}

const recordedPhaseTimings: PhaseTiming[] = [];

export function recordPhaseTiming(timing: PhaseTiming): void {
  recordedPhaseTimings.push({
    phase: timing.phase,
    label: timing.label,
    durationMs: Math.max(0, timing.durationMs),
    status: timing.status,
  });
}

export function getPhaseTimings(): readonly PhaseTiming[] {
  return recordedPhaseTimings.slice();
}

export function resetPhaseTimings(): void {
  recordedPhaseTimings.length = 0;
}

/**
 * Format a duration for humans: sub-minute values as `12.3s`, longer values as
 * `4m 07s` so multi-minute build phases read clearly.
 */
export function formatPhaseDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  // Rounding can push seconds to 60; roll it into the minute.
  const carry = seconds === 60 ? 1 : 0;
  const displaySeconds = seconds === 60 ? 0 : seconds;
  return `${minutes + carry}m ${String(displaySeconds).padStart(2, "0")}s`;
}

/**
 * Render a compact "Phase timings" summary block, or an empty string when no
 * phases were recorded (e.g. unit tests that never ran the progress reporter),
 * so callers can guard with a simple truthiness check.
 */
export function formatPhaseTimingsSummary(
  timings: readonly PhaseTiming[] = getPhaseTimings(),
): string {
  const rows = timings.filter((timing) => Number.isFinite(timing.durationMs));
  if (rows.length === 0) return "";

  const totalMs = rows.reduce((sum, timing) => sum + Math.max(0, timing.durationMs), 0);
  const labelWidth = Math.max("Total".length, ...rows.map((row) => row.label.length));
  const bar = `  ${"─".repeat(50)}`;

  const phaseRows = rows.map((row) => {
    const marker = row.status === "failed" ? "✗" : "✓";
    return `  ${marker} ${row.label.padEnd(labelWidth)}  ${formatPhaseDuration(row.durationMs)}`;
  });

  return [
    "",
    bar,
    "  Phase timings",
    bar,
    ...phaseRows,
    `    ${"Total".padEnd(labelWidth)}  ${formatPhaseDuration(totalMs)}`,
    bar,
  ].join("\n");
}
