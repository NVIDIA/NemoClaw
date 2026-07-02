// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../../state/onboard-session";
import { getPhaseTimings, recordPhaseTiming, resetPhaseTimings } from "../phase-timings";
import type { OnboardFlowContext } from "./flow-context";
import {
  coreOnboardFlowPhases,
  finalOnboardFlowPhases,
  initialOnboardFlowPhases,
  runCoreOnboardFlowSequence,
  runFinalOnboardFlowSequence,
  runInitialOnboardFlowSequence,
} from "./flow-slices";
import { advanceTo, branchTo, completeOnboardMachine } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import type { OnboardSequencePhase } from "./sequence-runner";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function runtime(initialSession: Session = createSession()) {
  let session = cloneSession(initialSession);
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    session = cloneSession(mutator(cloneSession(session)) ?? session);
    return cloneSession(session);
  };
  const deps: OnboardRuntimeDeps = {
    loadSession: () => cloneSession(session),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: () => cloneSession(session),
    markStepComplete: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => Object.assign(current, filterSafeUpdates(updates))),
    markStepCompleteRecordOnly: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => Object.assign(current, filterSafeUpdates(updates))),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: () => cloneSession(session),
    markStepFailedRecordOnly: () => cloneSession(session),
    completeSession: () => cloneSession(session),
    filterSafeUpdates,
    emitEvent: () => undefined,
    now: () => "2026-05-29T00:00:00.000Z",
  };
  return new OnboardRuntime(deps);
}

function context(): OnboardFlowContext {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: null,
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
  };
}

function phase(
  state: OnboardSequencePhase<OnboardFlowContext>["state"],
  next: ReturnType<typeof advanceTo>["next"],
): OnboardSequencePhase<OnboardFlowContext> {
  return { state, run: (ctx) => ({ context: ctx, result: advanceTo(next) }) };
}

describe("onboard flow slices", () => {
  it("selects only initial preflight/gateway phases", () => {
    expect(
      initialOnboardFlowPhases([
        phase("preflight", "gateway"),
        phase("gateway", "provider_selection"),
        phase("provider_selection", "inference"),
      ]).map((entry) => entry.state),
    ).toEqual(["init", "preflight", "gateway"]);
  });

  it("runs the initial slice from a default session and stops at provider selection", async () => {
    const result = await runInitialOnboardFlowSequence({
      context: context(),
      runtime: runtime(),
      phases: [
        phase("preflight", "gateway"),
        phase("gateway", "provider_selection"),
        phase("provider_selection", "inference"),
      ],
    });

    expect(result.session.machine.state).toBe("provider_selection");
  });

  it("runs the initial slice from preflight and stops at provider selection", async () => {
    const result = await runInitialOnboardFlowSequence({
      context: context(),
      runtime: runtime(
        createSession({
          machine: {
            version: MACHINE_SNAPSHOT_VERSION,
            state: "preflight",
            stateEnteredAt: "2026-05-29T00:00:00.000Z",
            revision: 0,
          },
        }),
      ),
      phases: [
        phase("preflight", "gateway"),
        phase("gateway", "provider_selection"),
        phase("provider_selection", "inference"),
      ],
    });

    expect(result.session.machine.state).toBe("provider_selection");
  });

  it("selects only core provider/sandbox phases", () => {
    expect(
      coreOnboardFlowPhases([
        phase("gateway", "provider_selection"),
        phase("provider_selection", "sandbox"),
        phase("sandbox", "openclaw"),
        phase("openclaw", "policies"),
      ]).map((entry) => entry.state),
    ).toEqual(["provider_selection", "sandbox"]);
  });

  it("runs the core slice and stops at the selected branch state", async () => {
    const result = await runCoreOnboardFlowSequence({
      context: context(),
      runtime: runtime(
        createSession({
          machine: {
            version: MACHINE_SNAPSHOT_VERSION,
            state: "provider_selection",
            stateEnteredAt: "2026-05-29T00:00:00.000Z",
            revision: 0,
          },
        }),
      ),
      phases: [
        {
          state: "provider_selection",
          run: (ctx) => ({
            context: ctx,
            result: [
              advanceTo("inference", { metadata: { state: "provider_selection" } }),
              advanceTo("sandbox", { metadata: { state: "inference" } }),
            ],
          }),
        },
        { state: "sandbox", run: (ctx) => ({ context: ctx, result: branchTo("openclaw") }) },
        phase("openclaw", "policies"),
      ],
    });

    expect(result.session.machine.state).toBe("openclaw");
  });

  it("selects final branch-to-complete phases", () => {
    expect(
      finalOnboardFlowPhases([
        phase("provider_selection", "inference"),
        phase("sandbox", "openclaw"),
        phase("openclaw", "policies"),
        phase("agent_setup", "policies"),
        phase("policies", "finalizing"),
        phase("finalizing", "post_verify"),
        {
          state: "post_verify",
          run: (ctx) => ({ context: ctx, result: completeOnboardMachine() }),
        },
      ]).map((entry) => entry.state),
    ).toEqual(["openclaw", "agent_setup", "policies", "finalizing", "post_verify"]);
  });

  it("runs the final slice from openclaw to completion", async () => {
    const result = await runFinalOnboardFlowSequence({
      context: context(),
      runtime: runtime(
        createSession({
          machine: {
            version: MACHINE_SNAPSHOT_VERSION,
            state: "openclaw",
            stateEnteredAt: "2026-05-29T00:00:00.000Z",
            revision: 0,
          },
        }),
      ),
      phases: [
        phase("openclaw", "policies"),
        phase("policies", "finalizing"),
        phase("finalizing", "post_verify"),
        {
          state: "post_verify",
          run: (ctx) => ({
            context: ctx,
            result: completeOnboardMachine({ sandboxName: "my-assistant" }),
          }),
        },
      ],
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
  });

  it("runs the final slice from agent setup to completion", async () => {
    const result = await runFinalOnboardFlowSequence({
      context: context(),
      runtime: runtime(
        createSession({
          machine: {
            version: MACHINE_SNAPSHOT_VERSION,
            state: "agent_setup",
            stateEnteredAt: "2026-05-29T00:00:00.000Z",
            revision: 0,
          },
        }),
      ),
      phases: [
        phase("agent_setup", "policies"),
        phase("policies", "finalizing"),
        phase("finalizing", "post_verify"),
        {
          state: "post_verify",
          run: (ctx) => ({
            context: ctx,
            result: completeOnboardMachine({ sandboxName: "my-assistant" }),
          }),
        },
      ],
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
  });
});

describe("onboard flow slices phase-timing summary (#6002)", () => {
  beforeEach(() => {
    resetPhaseTimings();
  });

  it("emits the accumulated timing summary and clears the registry after the final slice", async () => {
    // Timings recorded by earlier slices are still in the shared registry.
    recordPhaseTiming({
      phase: "sandbox",
      label: "Sandbox creation",
      durationMs: 250_000,
      status: "completed",
    });
    const summaries: string[] = [];

    await runFinalOnboardFlowSequence({
      context: context(),
      runtime: runtime(
        createSession({
          machine: {
            version: MACHINE_SNAPSHOT_VERSION,
            state: "finalizing",
            stateEnteredAt: "2026-05-29T00:00:00.000Z",
            revision: 0,
          },
        }),
      ),
      phases: [
        phase("finalizing", "post_verify"),
        {
          state: "post_verify",
          run: (ctx) => ({ context: ctx, result: completeOnboardMachine({}) }),
        },
      ],
      emitSummary: (summary) => summaries.push(summary),
    });

    // Summary emitted once at the terminal seam (after finalizing AND
    // post_verify complete), then the registry is cleared so nothing leaks into
    // a later run in the same process.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("Sandbox creation");
    expect(getPhaseTimings()).toHaveLength(0);
  });

  it("resets stale timings at the start of a new onboard run", async () => {
    // A prior run that failed before finalization can leave timings behind.
    recordPhaseTiming({
      phase: "gateway",
      label: "Gateway startup",
      durationMs: 4_000,
      status: "completed",
    });
    expect(getPhaseTimings()).toHaveLength(1);

    await runInitialOnboardFlowSequence({
      context: context(),
      runtime: runtime(),
      phases: [
        phase("preflight", "gateway"),
        phase("gateway", "provider_selection"),
        phase("provider_selection", "inference"),
      ],
    });

    // The start-of-run reset cleared the stale entry; the fresh run records
    // nothing here (the reporter is inert under Vitest), so the registry is empty.
    expect(getPhaseTimings()).toHaveLength(0);
  });
});
