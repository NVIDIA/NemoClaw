// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardMachineState, OnboardMachineTransition } from "./types";
import {
  ONBOARD_MACHINE_STATES,
  ONBOARD_NON_TERMINAL_MACHINE_STATES,
  ONBOARD_TERMINAL_MACHINE_STATES,
} from "./types";

/**
 * The legal onboarding transition graph.
 *
 * There are exactly two families of edges and no others:
 *
 * 1. Direct edges (`ONBOARD_MACHINE_DIRECT_TRANSITIONS`) — the forward flow
 *    plus the `inference -> provider_selection` retry and the
 *    `sandbox -> {openclaw,agent_setup}` branch. `kind` is `advance`, `retry`,
 *    or `branch`.
 * 2. Failure edges (`ONBOARD_MACHINE_FAILURE_TRANSITIONS`) — every non-terminal
 *    state may transition to `failed`. `kind` is `failure`.
 *
 * Terminality invariant: `complete` and `failed` are terminal and have no
 * outgoing edges. In particular there is deliberately **no** edge out of
 * `failed` into any agent/flow state, so a completed-then-reopened session can
 * never take an invalid `failed -> <agent>` transition (#6179).
 *
 * Recovery model: resuming an interrupted run does not transition out of a
 * terminal state. Instead a single, side-effect-free recovery pass
 * (`applySessionRecovery`) validates and re-seats the durable snapshot at a
 * legal non-terminal entry state before any flow handler runs and writes a
 * deterministic recovery receipt. After `onboard.resumed`, the runtime makes a
 * best-effort `state.repair.completed` dispatch attempt for that receipt. A
 * restart before the next transition retries the same receipt ID. Terminal
 * states therefore stay terminal within the graph while recovery remains
 * explicit and observable.
 */
export const ONBOARD_MACHINE_DIRECT_TRANSITIONS = [
  { from: "init", to: "preflight", kind: "advance" },
  { from: "preflight", to: "gateway", kind: "advance" },
  { from: "gateway", to: "provider_selection", kind: "advance" },
  { from: "provider_selection", to: "inference", kind: "advance" },
  { from: "inference", to: "provider_selection", kind: "retry" },
  { from: "inference", to: "sandbox", kind: "advance" },
  { from: "sandbox", to: "openclaw", kind: "branch" },
  { from: "sandbox", to: "agent_setup", kind: "branch" },
  { from: "openclaw", to: "policies", kind: "advance" },
  { from: "agent_setup", to: "policies", kind: "advance" },
  { from: "policies", to: "finalizing", kind: "advance" },
  { from: "finalizing", to: "post_verify", kind: "advance" },
  { from: "post_verify", to: "complete", kind: "advance" },
] as const satisfies readonly OnboardMachineTransition[];

export const ONBOARD_MACHINE_FAILURE_TRANSITIONS = ONBOARD_NON_TERMINAL_MACHINE_STATES.map(
  (from) => ({ from, to: "failed" as const, kind: "failure" as const }),
) satisfies readonly OnboardMachineTransition[];

export const ONBOARD_MACHINE_TRANSITIONS = [
  ...ONBOARD_MACHINE_DIRECT_TRANSITIONS,
  ...ONBOARD_MACHINE_FAILURE_TRANSITIONS,
] as const satisfies readonly OnboardMachineTransition[];

export const ONBOARD_MACHINE_NEXT_STATES: Readonly<
  Record<OnboardMachineState, readonly OnboardMachineState[]>
> = ONBOARD_MACHINE_STATES.reduce(
  (nextStates, state) => ({
    ...nextStates,
    [state]: ONBOARD_MACHINE_TRANSITIONS.filter((transition) => transition.from === state).map(
      (transition) => transition.to,
    ),
  }),
  {} as Record<OnboardMachineState, readonly OnboardMachineState[]>,
);

export class InvalidOnboardMachineTransitionError extends Error {
  readonly from: OnboardMachineState;
  readonly to: OnboardMachineState;

  constructor(from: OnboardMachineState, to: OnboardMachineState) {
    super(`Invalid onboarding machine transition: ${from} -> ${to}`);
    this.name = "InvalidOnboardMachineTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isOnboardMachineState(value: unknown): value is OnboardMachineState {
  return typeof value === "string" && ONBOARD_MACHINE_STATES.includes(value as OnboardMachineState);
}

export function isTerminalOnboardMachineState(
  state: OnboardMachineState,
): state is "complete" | "failed" {
  return ONBOARD_TERMINAL_MACHINE_STATES.includes(state as "complete" | "failed");
}

export function getNextOnboardMachineStates(
  from: OnboardMachineState,
): readonly OnboardMachineState[] {
  return ONBOARD_MACHINE_NEXT_STATES[from];
}

export function canTransitionOnboardMachineState(
  from: OnboardMachineState,
  to: OnboardMachineState,
): boolean {
  return getNextOnboardMachineStates(from).includes(to);
}

export function getOnboardMachineTransition(
  from: OnboardMachineState,
  to: OnboardMachineState,
): OnboardMachineTransition | null {
  return (
    ONBOARD_MACHINE_TRANSITIONS.find(
      (transition) => transition.from === from && transition.to === to,
    ) ?? null
  );
}

export function assertValidOnboardMachineTransition(
  from: OnboardMachineState,
  to: OnboardMachineState,
): OnboardMachineTransition {
  const transition = getOnboardMachineTransition(from, to);
  if (!transition) {
    throw new InvalidOnboardMachineTransitionError(from, to);
  }
  return transition;
}
