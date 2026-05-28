// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  type Session,
  type SessionUpdates,
  type StepMutationOptions,
} from "../../state/onboard-session";
import type { OnboardMachineEvent } from "./events";
import { advanceTo, branchTo, completeOnboardMachine } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import {
  createRecordOnlyOnboardRuntimeBoundary,
  runOnboardMachineWithRecordOnlySteps,
} from "./record-only-runner";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createHarness() {
  let session = createSession();
  const events: OnboardMachineEvent[] = [];

  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    session = cloneSession(mutator(cloneSession(session)) ?? session);
    return cloneSession(session);
  };
  const maybeLegacyTransition = (state: Session["machine"]["state"], options?: StepMutationOptions) => {
    if (options?.updateMachine === false) return;
    session.machine = {
      version: 1,
      state,
      stateEnteredAt: "legacy-step-transition",
      revision: session.machine.revision + 1,
    };
  };

  const deps: OnboardRuntimeDeps = {
    loadSession: () => cloneSession(session),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: (stepName: string, options?: StepMutationOptions) =>
      updateSession((current) => {
        current.steps[stepName].status = "in_progress";
        if (stepName === "preflight") maybeLegacyTransition("preflight", options);
        if (stepName === "gateway") maybeLegacyTransition("gateway", options);
        return current;
      }),
    markStepComplete: (stepName: string, updates: SessionUpdates = {}, options?: StepMutationOptions) =>
      updateSession((current) => {
        current.steps[stepName].status = "complete";
        Object.assign(current, filterSafeUpdates(updates));
        if (stepName === "preflight") maybeLegacyTransition("gateway", options);
        if (stepName === "gateway") maybeLegacyTransition("provider_selection", options);
        return current;
      }),
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.failure = { step: stepName, message: message ?? null, recordedAt: "now" };
        return current;
      }),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        return current;
      }),
    filterSafeUpdates,
    emitEvent: (event) => events.push(event),
    now: () => "2026-05-28T00:00:00.000Z",
  };

  return {
    events,
    getSession: () => cloneSession(session),
    boundary: createRecordOnlyOnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: () => new OnboardRuntime(deps),
    }),
  };
}

describe("record-only onboard runner", () => {
  it("lets handlers record steps while the runner owns machine transitions", async () => {
    const harness = createHarness();
    const recorders = harness.boundary.recorders();

    const result = await runOnboardMachineWithRecordOnlySteps({
      boundary: harness.boundary,
      context: { visited: [] as string[] },
      handlers: {
        init: () => advanceTo("preflight"),
        preflight: async () => {
          await recorders.startRecordedStep("preflight");
          expect(harness.getSession().machine.state).toBe("preflight");
          await recorders.recordStepComplete("preflight");
          expect(harness.getSession().machine.state).toBe("preflight");
          return advanceTo("gateway");
        },
        gateway: async () => {
          await recorders.startRecordedStep("gateway");
          expect(harness.getSession().machine.state).toBe("gateway");
          await recorders.recordStepComplete("gateway");
          expect(harness.getSession().machine.state).toBe("gateway");
          return advanceTo("provider_selection");
        },
        provider_selection: () => advanceTo("inference"),
        inference: () => advanceTo("sandbox"),
        sandbox: () => branchTo("openclaw"),
        openclaw: () => advanceTo("policies"),
        policies: () => advanceTo("finalizing"),
        finalizing: () => advanceTo("post_verify"),
        post_verify: () => completeOnboardMachine({ sandboxName: "my-assistant" }),
      },
      updateContext: ({ context, state }) => ({ visited: [...context.visited, state] }),
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
      steps: {
        preflight: { status: "complete" },
        gateway: { status: "complete" },
      },
    });
    expect(result.context.visited).toContain("preflight");
    expect(result.context.visited).toContain("gateway");
    expect(harness.events.map((event) => event.type)).toContain("onboard.started");
  });
});
