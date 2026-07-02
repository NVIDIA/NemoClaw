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
 *     in E2E trace artifacts. The end-of-onboard "Phase timings" summary is
 *     emitted separately from the final flow slice (see `flow-slices.ts`), once
 *     every wrapped phase has recorded — this reporter only records, it does
 *     not print the aggregate summary itself.
 *
 * Interactive phases (`provider_selection`, `policies`) are left out of the
 * heartbeat set *in interactive mode* so their prompts are not interrupted by
 * "still working" lines while waiting on human input. In non-interactive mode
 * (installer / Brev / `--yes`) they ARE heartbeated, because their wait-heavy
 * network/inference work then runs with no prompt to protect. Every phase is
 * timed regardless.
 *
 * The reporter is a no-op under the Vitest runner unless explicitly enabled, so
 * the many existing sequence/handler unit tests keep their exact output and are
 * not perturbed by interval timers. Real CLI and E2E runs (no `VITEST`) get the
 * heartbeats and timing lines; E2E can force either state with
 * `NEMOCLAW_ONBOARD_PROGRESS=1|0`.
 */

import { formatPhaseDuration, type PhaseTimingStatus, recordPhaseTiming } from "../phase-timings";
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

// Wait-heavy phases that can run silently for minutes and so need periodic
// heartbeats. All phases are still timed regardless of membership here.
const HEARTBEAT_PHASE_STATES: ReadonlySet<string> = new Set([
  "gateway",
  "sandbox",
  "inference",
  "agent_setup",
  "openclaw",
  "finalizing",
  "post_verify",
]);

// Phases that block on human input in interactive mode, where the wait-heavy
// non-interactive work (provider validation, first-inference setup, policy
// application) is interleaved with prompts. They are excluded from heartbeats
// in interactive mode so prompts aren't interrupted, but INCLUDED in
// non-interactive mode (installer / Brev / --yes), where the same phases run
// their network/inference work with no prompt to protect — exactly the silent
// window the issue reports (#6002).
const INTERACTIVE_PHASE_STATES: ReadonlySet<string> = new Set(["provider_selection", "policies"]);

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
  /**
   * Whether onboarding is running interactively. In non-interactive runs the
   * otherwise-interactive phases (provider selection, policies) also get
   * heartbeats, since their inference/network work has no prompt to protect.
   * Defaults to `!NEMOCLAW_NON_INTERACTIVE`.
   */
  interactive?: boolean;
}

export interface PhaseProgressReporter {
  wrap<Context>(phase: OnboardSequencePhase<Context>): OnboardSequencePhase<Context>;
}

function isVitestEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

function isInteractiveEnv(env: NodeJS.ProcessEnv): boolean {
  return !TRUTHY_FLAG_VALUES.has(
    String(env.NEMOCLAW_NON_INTERACTIVE ?? "")
      .trim()
      .toLowerCase(),
  );
}

function defaultHeartbeatPhaseStates(interactive: boolean): ReadonlySet<string> {
  if (interactive) return HEARTBEAT_PHASE_STATES;
  return new Set([...HEARTBEAT_PHASE_STATES, ...INTERACTIVE_PHASE_STATES]);
}

export function resolvePhaseProgressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = String(env.NEMOCLAW_ONBOARD_PROGRESS ?? "")
    .trim()
    .toLowerCase();
  if (TRUTHY_FLAG_VALUES.has(override)) return true;
  if (FALSY_FLAG_VALUES.has(override)) return false;
  return !isVitestEnv(env);
}

function resolveHeartbeatIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): number {
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
  const interactive = options.interactive ?? isInteractiveEnv(env);
  const heartbeatPhaseStates =
    options.heartbeatPhaseStates ?? defaultHeartbeatPhaseStates(interactive);

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

        // finish() only performs timing telemetry + logging. It runs in a
        // `finally` block, so every side effect is best-effort: a throwing
        // recorder/tracer/logger must never reclassify a successful phase as
        // failed, double-record, or mask the phase's real result/error.
        const finish = (status: PhaseTimingStatus): void => {
          if (timer) {
            try {
              clearTimer(timer);
            } catch {
              // Best-effort: the timer may already be cleared.
            }
          }
          const durationMs = Math.max(0, now() - startedAt);
          try {
            record({ phase: phase.state, label, durationMs, status });
            traceEvent("onboard.phase.timing", {
              phase: phase.state,
              duration_ms: durationMs,
              status,
              heartbeats,
            });
            if (durationMs >= completionThresholdMs) {
              const marker = status === "failed" ? "✗" : "✓";
              const verb = status === "failed" ? "failed after" : "completed in";
              logLine(`  ${marker} ${label} ${verb} ${formatPhaseDuration(durationMs)}`);
            }
          } catch {
            // Progress telemetry is best-effort; never let it affect the phase.
          }
        };

        let status: PhaseTimingStatus = "completed";
        try {
          return await phase.run(context);
        } catch (error) {
          status = "failed";
          throw error;
        } finally {
          // Exactly one finish() call, with the real outcome, regardless of
          // whether phase.run resolved or threw.
          finish(status);
        }
      },
    };
  }

  return { wrap };
}

// One reporter per process, shared by every onboarding seam (the initial/core/
// final strict runs and the resume-compatibility path) so a run does not create
// several independent reporters and every phase — including resume-repair — is
// wrapped consistently. Env is read once at first use, which is fine for a
// single onboard invocation.
let sharedReporter: PhaseProgressReporter | null = null;

export function getDefaultPhaseProgressReporter(): PhaseProgressReporter {
  if (!sharedReporter) sharedReporter = createPhaseProgressReporter();
  return sharedReporter;
}

/** Test hook: drop the memoized shared reporter so the next call rebuilds it. */
export function resetDefaultPhaseProgressReporter(): void {
  sharedReporter = null;
}
