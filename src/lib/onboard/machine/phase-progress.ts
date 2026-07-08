// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardSequencePhase } from "./sequence-runner";
import type { OnboardNonTerminalMachineState } from "./types";

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

const HEARTBEAT_PHASE_STATES: ReadonlySet<OnboardNonTerminalMachineState> = new Set([
  "gateway",
  "inference",
  "sandbox",
  "agent_setup",
  "openclaw",
  "finalizing",
  "post_verify",
]);
const INTERACTIVE_PHASE_STATES: ReadonlySet<OnboardNonTerminalMachineState> = new Set([
  "provider_selection",
  "policies",
]);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface PhaseProgressTimer {
  unref?(): void;
}

export interface PhaseProgressOptions {
  enabled?: boolean;
  interactive?: boolean;
  heartbeatIntervalMs?: number;
  logLine?: (line: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, intervalMs: number) => PhaseProgressTimer;
  clearTimer?: (timer: PhaseProgressTimer) => void;
}

export interface PhaseProgressReporter {
  wrap<Context>(phase: OnboardSequencePhase<Context>): OnboardSequencePhase<Context>;
}

/** Add bounded progress output around one onboarding phase without shared state. */
export function createPhaseProgressReporter(
  options: PhaseProgressOptions = {},
): PhaseProgressReporter {
  const interactive = options.interactive ?? process.env.NEMOCLAW_NON_INTERACTIVE !== "1";
  const heartbeatStates = interactive
    ? HEARTBEAT_PHASE_STATES
    : new Set([...HEARTBEAT_PHASE_STATES, ...INTERACTIVE_PHASE_STATES]);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const logLine = options.logLine ?? console.log;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
  const clearTimer =
    options.clearTimer ?? ((timer: PhaseProgressTimer) => clearInterval(timer as NodeJS.Timeout));
  const enabled = options.enabled ?? true;

  return {
    wrap<Context>(phase: OnboardSequencePhase<Context>): OnboardSequencePhase<Context> {
      if (!enabled || !heartbeatStates.has(phase.state)) return phase;
      return {
        state: phase.state,
        async run(context) {
          const label = ONBOARD_PHASE_LABELS[phase.state];
          const startedAt = now();
          const timer = setTimer(() => {
            const elapsedSeconds = Math.max(0, Math.round((now() - startedAt) / 1000));
            try {
              logLine(`  ⏳ Still working on ${label}… (${elapsedSeconds}s elapsed)`);
            } catch {
              // Progress output must never interrupt onboarding.
            }
          }, heartbeatIntervalMs);
          timer.unref?.();
          try {
            return await phase.run(context);
          } finally {
            try {
              clearTimer(timer);
            } catch {
              // The timer may already have been cleared during shutdown.
            }
          }
        },
      };
    },
  };
}
