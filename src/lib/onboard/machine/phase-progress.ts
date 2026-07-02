// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase-level progress + timing for the onboarding sequence runner.
 *
 * Wraps each `OnboardSequencePhase.run` so that:
 *
 *   - Long non-interactive phases (gateway startup, sandbox creation, inference
 *     setup, agent setup, finalization) emit a periodic "Still working on …"
 *     heartbeat, guaranteeing the user never sees a silent terminal for more
 *     than the heartbeat interval (default 30s, well under the 60s ceiling from
 *     issue #6002). `create-stream` already heartbeats *inside* the sandbox
 *     build; this covers the surrounding phases that previously waited in
 *     silence (gateway health poll, in-sandbox smoke test, OpenClaw setup).
 *   - Every phase records its wall-clock duration (into `phase-timings`) and
 *     emits an `onboard.phase.timing` trace event, so timings are collectable
 *     in E2E trace artifacts and summarised for the user at the end.
 *
 * Interactive phases (`provider_selection`, `policies`) are intentionally left
 * out of the heartbeat set so their prompts are not interrupted by "still
 * working" lines while waiting on human input. They are still timed.
 *
 * The reporter is a no-op under the Vitest runner unless explicitly enabled, so
 * the many existing sequence/handler unit tests keep their exact output and are
 * not perturbed by interval timers. Real CLI and E2E runs (no `VITEST`) get the
 * heartbeats and timing lines; E2E can force either state with
 * `NEMOCLAW_ONBOARD_PROGRESS=1|0`.
 */

import {
  formatPhaseDuration,
  formatPhaseTimingsSummary,
  type PhaseTimingStatus,
  recordPhaseTiming,
  resetPhaseTimings,
} from "../phase-timings";
import { addTraceEvent } from "../tracing";
import type { OnboardSequencePhase } from "./sequence-runner";
import type { OnboardNonTerminalMachineState } from "./types";

// Keyed by every non-terminal FSM state so a newly-added onboarding state is a
// compile error here until it gets a friendly label, rather than silently
// falling back to the raw state id.
export const ONBOARD_PHASE_LABELS: Readonly<Record<OnboardNonTerminalMachineState, string>> = {
  init: "Initialization",
  preflight: "Preflight checks",
  gateway: "Gateway startup",
  provider_selection: "Provider selection",
  inference: "Inference setup",
  sandbox: "Sandbox creation",
  agent_setup: "Agent setup",
  openclaw: "OpenClaw setup",
  policies: "Network policies",
  finalizing: "Finalization",
  post_verify: "Verification",
};

// Non-interactive, wait-heavy phases that can run silently for minutes and so
// need periodic heartbeats. Interactive phases are excluded so prompts aren't
// interrupted; all phases are still timed regardless of membership here.
const HEARTBEAT_PHASE_STATES: ReadonlySet<string> = new Set([
  "gateway",
  "sandbox",
  "inference",
  "agent_setup",
  "openclaw",
  "finalizing",
  "post_verify",
]);

// Terminal phase(s) after which the accumulated per-phase timing summary is
// emitted. Emitting from this seam — after the wrapped phase's own duration is
// recorded — means the summary includes the finalization phase itself and the
// registry is reset only once every phase has been written, so no stray entry
// leaks into a later onboard in the same process (#6002 review PRA-2/PRA-8).
const SUMMARY_PHASE_STATES: ReadonlySet<string> = new Set(["finalizing"]);

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_COMPLETION_THRESHOLD_MS = 5_000;

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export interface PhaseProgressTimer {
  unref?(): void;
}

export interface PhaseProgressRecord {
  phase: string;
  label: string;
  durationMs: number;
  status: PhaseTimingStatus;
}

export interface PhaseProgressOptions {
  /**
   * Environment source. Used for both `resolvePhaseProgressEnabled` and the
   * heartbeat-interval override so a single injected env drives every env-backed
   * decision. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Force enable/disable. Defaults to `resolvePhaseProgressEnabled(env)`. */
  enabled?: boolean;
  logLine?: (line: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => PhaseProgressTimer;
  clearTimer?: (timer: PhaseProgressTimer) => void;
  traceEvent?: (name: string, attributes?: Record<string, unknown>) => void;
  record?: (record: PhaseProgressRecord) => void;
  heartbeatIntervalMs?: number;
  completionThresholdMs?: number;
  labels?: Readonly<Record<string, string>>;
  heartbeatPhaseStates?: ReadonlySet<string>;
  /** Phase states after which to emit the accumulated timing summary. */
  summaryPhaseStates?: ReadonlySet<string>;
  /** Emit the rendered summary block. Defaults to `logLine`. */
  emitSummary?: (summary: string) => void;
  /** Render the accumulated summary. Defaults to `formatPhaseTimingsSummary`. */
  formatSummary?: () => string;
  /** Clear the timing registry after the summary is emitted. */
  resetTimings?: () => void;
}

export interface PhaseProgressReporter {
  wrap<Context>(phase: OnboardSequencePhase<Context>): OnboardSequencePhase<Context>;
}

function isVitestEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

export function resolvePhaseProgressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = String(env.NEMOCLAW_ONBOARD_PROGRESS ?? "")
    .trim()
    .toLowerCase();
  if (TRUTHY_FLAG_VALUES.has(override)) return true;
  if (FALSY_FLAG_VALUES.has(override)) return false;
  return !isVitestEnv(env);
}

function resolveHeartbeatIntervalMs(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = Number(env.NEMOCLAW_ONBOARD_HEARTBEAT_MS);
  if (Number.isFinite(raw) && raw >= MIN_HEARTBEAT_INTERVAL_MS) return Math.floor(raw);
  return fallback;
}

export function createPhaseProgressReporter(
  options: PhaseProgressOptions = {},
): PhaseProgressReporter {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? resolvePhaseProgressEnabled(env);
  const logLine = options.logLine ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
  const clearTimer =
    options.clearTimer ?? ((timer: PhaseProgressTimer) => clearInterval(timer as NodeJS.Timeout));
  const traceEvent = options.traceEvent ?? addTraceEvent;
  const record = options.record ?? recordPhaseTiming;
  const labels = options.labels ?? ONBOARD_PHASE_LABELS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? resolveHeartbeatIntervalMs(env, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const completionThresholdMs = options.completionThresholdMs ?? DEFAULT_COMPLETION_THRESHOLD_MS;
  const heartbeatPhaseStates = options.heartbeatPhaseStates ?? HEARTBEAT_PHASE_STATES;
  const summaryPhaseStates = options.summaryPhaseStates ?? SUMMARY_PHASE_STATES;
  const emitSummary = options.emitSummary ?? logLine;
  const formatSummary = options.formatSummary ?? formatPhaseTimingsSummary;
  const resetTimings = options.resetTimings ?? resetPhaseTimings;

  function wrap<Context>(phase: OnboardSequencePhase<Context>): OnboardSequencePhase<Context> {
    if (!enabled) return phase;
    const label = labels[phase.state] ?? phase.state;
    return {
      state: phase.state,
      async run(context) {
        const startedAt = now();
        let heartbeats = 0;
        const timer = heartbeatPhaseStates.has(phase.state)
          ? setTimer(() => {
              heartbeats += 1;
              const elapsedSeconds = Math.max(0, Math.round((now() - startedAt) / 1000));
              logLine(`  ⏳ Still working on ${label}… (${elapsedSeconds}s elapsed)`);
            }, heartbeatIntervalMs)
          : null;
        timer?.unref?.();

        const finish = (status: PhaseTimingStatus): void => {
          if (timer) clearTimer(timer);
          const durationMs = Math.max(0, now() - startedAt);
          record({ phase: phase.state, label, durationMs, status });
          traceEvent("onboard.phase.timing", {
            phase: phase.state,
            duration_ms: durationMs,
            status,
            heartbeats,
          });
          const isSummaryPhase = summaryPhaseStates.has(phase.state);
          // Summary phases fold their own timing into the summary block below,
          // so skip the redundant standalone completion line on success.
          if (durationMs >= completionThresholdMs && (!isSummaryPhase || status === "failed")) {
            const marker = status === "failed" ? "✗" : "✓";
            const verb = status === "failed" ? "failed after" : "completed in";
            logLine(`  ${marker} ${label} ${verb} ${formatPhaseDuration(durationMs)}`);
          }
          if (status === "completed" && isSummaryPhase) {
            const summary = formatSummary();
            if (summary) {
              emitSummary(summary);
              resetTimings();
            }
          }
        };

        try {
          const result = await phase.run(context);
          finish("completed");
          return result;
        } catch (error) {
          finish("failed");
          throw error;
        }
      },
    };
  }

  return { wrap };
}
