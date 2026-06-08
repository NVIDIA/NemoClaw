// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type { OnboardStateResult } from "./result";
import { isOnboardMachineState, isTerminalOnboardMachineState } from "./transitions";
import type { OnboardMachineState, OnboardNonTerminalMachineState } from "./types";

export type OnboardStateHandlerResult = OnboardStateResult | readonly OnboardStateResult[];

export type OnboardStateHandler<Context> = (
  context: Context,
) => Promise<OnboardStateHandlerResult> | OnboardStateHandlerResult;

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

export class EmptyOnboardStateHandlerResultError extends Error {
  readonly state: OnboardNonTerminalMachineState;

  constructor(state: OnboardNonTerminalMachineState) {
    super(`Onboarding machine handler for state '${state}' returned no results`);
    this.name = "EmptyOnboardStateHandlerResultError";
    this.state = state;
  }
}

export class OnboardMachineResultSequenceSourceError extends Error {
  readonly currentState: OnboardMachineState;
  readonly resultIndex: number;
  readonly sourceState: string | null;

  constructor(options: {
    currentState: OnboardMachineState;
    resultIndex: number;
    sourceState: string | null;
  }) {
    const ordinal = options.resultIndex + 1;
    const problem = options.sourceState
      ? `declares source state '${options.sourceState}' but current state is '${options.currentState}'`
      : "must declare a source state in metadata.state";
    super(`Onboarding machine result sequence item ${ordinal} ${problem}`);
    this.name = "OnboardMachineResultSequenceSourceError";
    this.currentState = options.currentState;
    this.resultIndex = options.resultIndex;
    this.sourceState = options.sourceState;
  }
}

const DEFAULT_MAX_TRANSITIONS = 100;

function normalizeMaxTransitions(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TRANSITIONS;
  return Math.max(1, Math.trunc(value));
}

function resultSourceState(result: OnboardStateResult): string | null {
  const state = result.metadata?.state;
  return typeof state === "string" ? state : null;
}

function assertResultSourceState(
  result: OnboardStateResult,
  currentState: OnboardMachineState,
  resultIndex: number,
  requireSourceState: boolean,
): void {
  const sourceState = resultSourceState(result);
  if (!sourceState) {
    if (requireSourceState) {
      throw new OnboardMachineResultSequenceSourceError({
        currentState,
        resultIndex,
        sourceState,
      });
    }
    return;
  }
  if (!isOnboardMachineState(sourceState) || sourceState !== currentState) {
    throw new OnboardMachineResultSequenceSourceError({
      currentState,
      resultIndex,
      sourceState,
    });
  }
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

    const handlerResult = await handler(context);
    const results = Array.isArray(handlerResult) ? handlerResult : [handlerResult];
    if (results.length === 0) {
      throw new EmptyOnboardStateHandlerResultError(state as OnboardNonTerminalMachineState);
    }
    const requireSourceState = results.length > 1;

    for (const [resultIndex, result] of results.entries()) {
      if (transitions >= transitionLimit) {
        throw new OnboardMachineTransitionLimitError(transitionLimit);
      }
      const resultState = session.machine.state;
      assertResultSourceState(result, resultState, resultIndex, requireSourceState);
      session = await runtime.applyResult(result);
      transitions += 1;
      context = updateContext
        ? await updateContext({ context, state: resultState, result, session })
        : context;
      if (isTerminalOnboardMachineState(session.machine.state)) break;
    }
  }

  return { context, session };
}
