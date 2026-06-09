// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../state/onboard-session";
import { advanceTo } from "./result";
import { runLiveOnboardFlowSlice } from "./live-flow-slice";
import type { OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

interface Context {
  value: number;
}

function runtime(state: Session["machine"]["state"]): OnboardMachineRunnerRuntime {
  const session = createSession({
    machine: { version: 1, state, stateEnteredAt: null, revision: 1 },
  });
  return {
    async session() {
      return session;
    },
    async applyResult() {
      return session;
    },
  };
}

function phase(
  state: OnboardSequencePhase<Context>["state"],
  next: number,
): OnboardSequencePhase<Context> {
  return {
    state,
    run: (context) => ({
      context: { value: next },
      result: advanceTo("gateway"),
    }),
  };
}

describe("runLiveOnboardFlowSlice", () => {
  it("uses the strict slice runner for fresh matching entry states", async () => {
    const runSlice = vi.fn(async ({ context }) => ({
      context: { value: context.value + 1 },
      session: "strict",
    }));
    const applyCompatibleResult = vi.fn(async () => undefined);

    const result = await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: runtime("preflight"),
      phases: [phase("preflight", 2)],
      resume: false,
      runWhenState: ["preflight"],
      runSlice,
      applyCompatibleResult,
    });

    expect(result).toEqual({ context: { value: 2 }, session: "strict" });
    expect(runSlice).toHaveBeenCalledOnce();
    expect(applyCompatibleResult).not.toHaveBeenCalled();
  });

  it("uses compatibility execution for resume or ahead-state flows", async () => {
    const runSlice = vi.fn(async ({ context }) => ({ context, session: "strict" }));
    const applyCompatibleResult = vi.fn(async () => undefined);

    const result = await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: runtime("provider_selection"),
      phases: [
        phase("preflight", 2),
        {
          state: "gateway",
          run: (context) => ({
            context: { value: context.value + 1 },
            result: [advanceTo("provider_selection"), advanceTo("inference")],
          }),
        },
      ],
      resume: true,
      runWhenState: ["preflight"],
      runSlice,
      applyCompatibleResult,
    });

    expect(result.context).toEqual({ value: 3 });
    expect(runSlice).not.toHaveBeenCalled();
    expect(applyCompatibleResult).toHaveBeenCalledTimes(3);
  });
});
