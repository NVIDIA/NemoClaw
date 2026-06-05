// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type { OnboardStateResult } from "./result";
import { isTerminalOnboardMachineState } from "./transitions";
import type { OnboardMachineState, OnboardNonTerminalMachineState } from "./types";

export type OnboardStateHandler<Context> = (
  context: Context,
) => Promise<OnboardStateResult> | OnboardStateResult;

export type OnboardStateHandlers<Context> = Partial<
  Record<OnboardNonTerminalMachineState, OnboardStateHandler<Context>>
>;

export interface OnboardMachineRunnerRuntime {
  session(): Promise<Session>;
  applyResult(result: OnboardStateResult): Promise<Session>;
}

export interface OnboardMachineRunnerOptions<Context> {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  handlers: OnboardStateHandlers<Context>;
  /**
   * Safety valve for retry-capable handlers. Handlers should bound their own
   * retry loops, but the runner refuses to apply unbounded transitions.
   */
  maxTransitions?: number;
  updateContext?(input: {
    context: Context;
    state: OnboardMachineState;
    result: OnboardStateResult;
    session: Session;
  }): Context | Promise<Context>;
}

export interface OnboardMachineRunnerResult<Context> {
  context: Context;
  session: Session;
}

export class MissingOnboardStateHandlerError extends Error {
  readonly state: OnboardNonTerminalMachineState;

  constructor(state: OnboardNonTerminalMachineState) {
    super(`Missing onboarding machine handler for state: ${state}`);
    this.name = "MissingOnboardStateHandlerError";
    this.state = state;
  }
}

export class OnboardMachineTransitionLimitError extends Error {
  readonly maxTransitions: number;

  constructor(maxTransitions: number) {
    super(`Onboarding machine exceeded transition limit: ${maxTransitions}`);
    this.name = "OnboardMachineTransitionLimitError";
    this.maxTransitions = maxTransitions;
  }
}

const DEFAULT_MAX_TRANSITIONS = 100;

function normalizeMaxTransitions(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TRANSITIONS;
  return Math.max(1, Math.trunc(value));
}

export async function runOnboardMachine<Context>({
  context: initialContext,
  runtime,
  handlers,
  maxTransitions,
  updateContext,
}: OnboardMachineRunnerOptions<Context>): Promise<OnboardMachineRunnerResult<Context>> {
  let context = initialContext;
  let session = await runtime.session();
  let transitions = 0;
  const transitionLimit = normalizeMaxTransitions(maxTransitions);

  while (!isTerminalOnboardMachineState(session.machine.state)) {
    if (transitions >= transitionLimit) {
      throw new OnboardMachineTransitionLimitError(transitionLimit);
    }
    const state = session.machine.state;
    const handler = handlers[state as OnboardNonTerminalMachineState];
    if (!handler) throw new MissingOnboardStateHandlerError(state as OnboardNonTerminalMachineState);

    const result = await handler(context);
    session = await runtime.applyResult(result);
    transitions += 1;
    context = updateContext
      ? await updateContext({ context, state, result, session })
      : context;
  }

  return { context, session };
}
