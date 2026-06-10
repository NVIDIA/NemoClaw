// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../state/onboard-session";
import {
  EmptyLiveOnboardFlowSliceResultError,
  runLiveOnboardFlowSlice,
  UnexpectedLiveOnboardFlowSliceStateError,
} from "./live-flow-slice";
import { advanceTo, type OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime } from "./runner";
import { DuplicateOnboardSequencePhaseError, type OnboardSequencePhase } from "./sequence-runner";

interface Context {
  value: number;
}

function runtime(state: Session["machine"]["state"]): {
  runtime: OnboardMachineRunnerRuntime;
  applyResult(result: OnboardStateResult): Promise<Session>;
  session(): Session;
} {
  let session = createSession({
    machine: { version: 1, state, stateEnteredAt: null, revision: 1 },
  });
  const runtimeApi: OnboardMachineRunnerRuntime = {
    async session() {
      return session;
    },
    async applyResult(result) {
      if (result.type === "transition") {
        session = {
          ...session,
          machine: {
            ...session.machine,
            state: result.next,
            revision: session.machine.revision + 1,
          },
        };
      }
      return session;
    },
  };
  return {
    runtime: runtimeApi,
    applyResult(result) {
      return runtimeApi.applyResult(result);
    },
    session() {
      return session;
    },
  };
}

function phase(
  state: OnboardSequencePhase<Context>["state"],
  next: number,
  result: OnboardStateResult | readonly OnboardStateResult[] = advanceTo("gateway"),
): OnboardSequencePhase<Context> {
  return {
    state,
    run: vi.fn((context) => ({
      context: { value: next },
      result,
    })),
  };
}

describe("runLiveOnboardFlowSlice", () => {
  it("uses the strict slice runner for fresh matching entry states", async () => {
    const runSlice = vi.fn(async ({ context }) => ({
      context: { value: context.value + 1 },
      session: createSession(),
    }));
    const applyCompatibleResult = vi.fn(async () => undefined);

    const result = await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: runtime("preflight").runtime,
      phases: [phase("preflight", 2)],
      resume: false,
      runWhenState: ["preflight"],
      compatibilityWhenState: ["provider_selection"],
      runSlice,
      applyCompatibleResult,
    });

    expect(result.context).toEqual({ value: 2 });
    expect(runSlice).toHaveBeenCalledOnce();
    expect(applyCompatibleResult).not.toHaveBeenCalled();
  });

  it("applies compatibility results in exact phase order and returns the updated session", async () => {
    const liveRuntime = runtime("provider_selection");
    const runSlice = vi.fn(async ({ context }) => ({ context, session: createSession() }));
    const results = [
      advanceTo("gateway"),
      advanceTo("provider_selection", { metadata: { state: "gateway" } }),
      advanceTo("inference", { metadata: { state: "provider_selection" } }),
    ];
    const applyCompatibleResult = vi.fn(async (result: OnboardStateResult) =>
      liveRuntime.applyResult(result),
    );

    const result = await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: liveRuntime.runtime,
      phases: [
        phase("preflight", 2, results[0]),
        {
          state: "gateway",
          run: vi.fn((context) => ({
            context: { value: context.value + 1 },
            result: [results[1], results[2]],
          })),
        },
      ],
      resume: true,
      runWhenState: ["preflight"],
      runSlice,
      applyCompatibleResult,
    });

    expect(result.context).toEqual({ value: 3 });
    expect(result.session.machine.state).toBe("inference");
    expect(runSlice).not.toHaveBeenCalled();
    expect(applyCompatibleResult.mock.calls.map(([result]) => result)).toEqual(results);
  });

  it("keeps resume-at-entry flows on compatibility execution", async () => {
    const liveRuntime = runtime("preflight");
    const runSlice = vi.fn(async ({ context }) => ({ context, session: createSession() }));
    const applyCompatibleResult = vi.fn(async (result: OnboardStateResult) =>
      liveRuntime.applyResult(result),
    );

    await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: liveRuntime.runtime,
      phases: [phase("preflight", 2)],
      resume: true,
      runWhenState: ["preflight"],
      runSlice,
      applyCompatibleResult,
    });

    expect(runSlice).not.toHaveBeenCalled();
    expect(applyCompatibleResult).toHaveBeenCalledOnce();
  });

  it("keeps non-resume ahead-state flows on compatibility execution", async () => {
    const liveRuntime = runtime("provider_selection");
    const runSlice = vi.fn(async ({ context }) => ({ context, session: createSession() }));
    const applyCompatibleResult = vi.fn(async (result: OnboardStateResult) =>
      liveRuntime.applyResult(result),
    );

    await runLiveOnboardFlowSlice({
      context: { value: 1 },
      runtime: liveRuntime.runtime,
      phases: [phase("preflight", 2)],
      resume: false,
      runWhenState: ["preflight"],
      compatibilityWhenState: ["provider_selection"],
      runSlice,
      applyCompatibleResult,
    });

    expect(runSlice).not.toHaveBeenCalled();
    expect(applyCompatibleResult).toHaveBeenCalledOnce();
  });

  it("rejects non-resume states before the slice entry before running side effects", async () => {
    const liveRuntime = runtime("init");
    const blocked = phase("provider_selection", 2);
    const runSlice = vi.fn(async ({ context }) => ({ context, session: createSession() }));
    const applyCompatibleResult = vi.fn(async () => undefined);

    await expect(
      runLiveOnboardFlowSlice({
        context: { value: 1 },
        runtime: liveRuntime.runtime,
        phases: [blocked],
        resume: false,
        runWhenState: ["provider_selection"],
        compatibilityWhenState: ["inference", "sandbox"],
        runSlice,
        applyCompatibleResult,
      }),
    ).rejects.toBeInstanceOf(UnexpectedLiveOnboardFlowSliceStateError);

    expect(runSlice).not.toHaveBeenCalled();
    expect(blocked.run).not.toHaveBeenCalled();
    expect(applyCompatibleResult).not.toHaveBeenCalled();
  });

  it("rejects duplicate compatibility phases before running side effects", async () => {
    const liveRuntime = runtime("provider_selection");
    const first = phase("preflight", 2);
    const second = phase("preflight", 3);
    const applyCompatibleResult = vi.fn(async () => undefined);

    await expect(
      runLiveOnboardFlowSlice({
        context: { value: 1 },
        runtime: liveRuntime.runtime,
        phases: [first, second],
        resume: true,
        runWhenState: ["preflight"],
        runSlice: vi.fn(),
        applyCompatibleResult,
      }),
    ).rejects.toBeInstanceOf(DuplicateOnboardSequencePhaseError);

    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).not.toHaveBeenCalled();
    expect(applyCompatibleResult).not.toHaveBeenCalled();
  });

  it("rejects empty compatibility phase results", async () => {
    const liveRuntime = runtime("provider_selection");
    const applyCompatibleResult = vi.fn(async () => undefined);

    await expect(
      runLiveOnboardFlowSlice({
        context: { value: 1 },
        runtime: liveRuntime.runtime,
        phases: [phase("preflight", 2, [])],
        resume: true,
        runWhenState: ["preflight"],
        runSlice: vi.fn(),
        applyCompatibleResult,
      }),
    ).rejects.toBeInstanceOf(EmptyLiveOnboardFlowSliceResultError);

    expect(applyCompatibleResult).not.toHaveBeenCalled();
  });

  it("propagates compatibility application failures without running later phases", async () => {
    const liveRuntime = runtime("provider_selection");
    const later = phase("gateway", 3);
    const applyCompatibleResult = vi.fn(async () => {
      throw new Error("compatibility failed");
    });

    await expect(
      runLiveOnboardFlowSlice({
        context: { value: 1 },
        runtime: liveRuntime.runtime,
        phases: [phase("preflight", 2), later],
        resume: true,
        runWhenState: ["preflight"],
        runSlice: vi.fn(),
        applyCompatibleResult,
      }),
    ).rejects.toThrow("compatibility failed");

    expect(applyCompatibleResult).toHaveBeenCalledOnce();
    expect(later.run).not.toHaveBeenCalled();
  });
});
