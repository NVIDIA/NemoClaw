// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type { OnboardStateResult } from "./result";
import { isTerminalOnboardMachineState } from "./transitions";
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
  updateContext?(input: {
    context: Context;
    state: OnboardMachineState;
    result: OnboardStateResult;
    session: Session;
  }): Context | Promise<Context>;
  stopStates?: readonly OnboardMachineState[];
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

export async function runOnboardMachine<Context>({
  context: initialContext,
  runtime,
  handlers,
  updateContext,
  stopStates = [],
}: OnboardMachineRunnerOptions<Context>): Promise<OnboardMachineRunnerResult<Context>> {
  let context = initialContext;
  let session = await runtime.session();

  while (!isTerminalOnboardMachineState(session.machine.state) && !stopStates.includes(session.machine.state)) {
    const state = session.machine.state;
    const handler = handlers[state as OnboardNonTerminalMachineState];
    if (!handler) throw new MissingOnboardStateHandlerError(state as OnboardNonTerminalMachineState);

    const handlerResult = await handler(context);
    const results = Array.isArray(handlerResult) ? handlerResult : [handlerResult];
    if (results.length === 0) {
      throw new Error(`Onboarding machine handler for state '${state}' returned no results`);
    }

    for (const result of results) {
      session = await runtime.applyResult(result);
      context = updateContext
        ? await updateContext({ context, state, result, session })
        : context;
    }
  }

  return { context, session };
}
