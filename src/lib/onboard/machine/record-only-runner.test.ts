// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../../state/onboard-session";
import type { StepMutationOptions } from "../../state/onboard-step-mutation";
import type { OnboardMachineEvent } from "./events";
import {
  createRecordOnlyOnboardRuntimeBoundary,
  type RecordOnlyOnboardRuntimeBoundaryOptions,
  runOnboardMachineWithRecordOnlySteps,
} from "./record-only-runner";
import { advanceTo, branchTo, completeOnboardMachine, failOnboardMachine } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function completionHandlers() {
  return {
    preflight: () => advanceTo("gateway"),
    gateway: () => advanceTo("provider_selection"),
    provider_selection: () => advanceTo("inference"),
    inference: () => advanceTo("sandbox"),
    sandbox: () => branchTo("openclaw"),
    openclaw: () => advanceTo("policies"),
    policies: () => advanceTo("finalizing"),
    finalizing: () => advanceTo("post_verify"),
    post_verify: () => completeOnboardMachine(),
  };
}

function createHarness(
  options: Pick<RecordOnlyOnboardRuntimeBoundaryOptions, "stepMutationOptions"> = {},
) {
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
    markStepCompleteRecordOnly: (stepName: string, updates: SessionUpdates = {}) =>
      updateSession((current) => {
        current.steps[stepName].status = "complete";
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message, options) =>
      updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.steps[stepName].error = message ?? null;
        if (options?.updateMachine !== false) {
          current.status = "failed";
          current.failure = { step: stepName, message: message ?? null, recordedAt: "now" };
          maybeLegacyTransition("failed", options);
        }
        return current;
      }),
    markStepFailedRecordOnly: (stepName, message) =>
      updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.steps[stepName].error = message ?? null;
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
      ...options,
    }),
  };
}

describe("record-only onboard runner", () => {
  it("lets handlers record steps while the runner owns machine transitions", async () => {
    const harness = createHarness();
    const recorders = harness.boundary.recorders();
    expect("recordStateResult" in recorders).toBe(false);

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

  it("forces record-only step mutations even if caller options ask to update the machine", async () => {
    const harness = createHarness({
      stepMutationOptions: { updateMachine: true } as RecordOnlyOnboardRuntimeBoundaryOptions["stepMutationOptions"],
    });
    const recorders = harness.boundary.recorders();

    await recorders.startRecordedStep("preflight");
    await recorders.recordStepComplete("preflight");

    expect(harness.getSession()).toMatchObject({
      machine: { state: "init", revision: 0 },
      steps: { preflight: { status: "complete" } },
    });
  });

  it("emits resumed lifecycle events and can skip lifecycle emission", async () => {
    const resumedHarness = createHarness();
    await runOnboardMachineWithRecordOnlySteps({
      boundary: resumedHarness.boundary,
      resumed: true,
      context: {},
      handlers: { init: () => advanceTo("preflight"), ...completionHandlers() },
    });
    expect(resumedHarness.events[0]).toMatchObject({ type: "onboard.resumed" });

    const quietHarness = createHarness();
    await runOnboardMachineWithRecordOnlySteps({
      boundary: quietHarness.boundary,
      emitLifecycleEvent: false,
      context: {},
      handlers: { init: () => advanceTo("preflight"), ...completionHandlers() },
    });
    expect(quietHarness.events.map((event) => event.type)).not.toContain("onboard.started");
    expect(quietHarness.events.map((event) => event.type)).not.toContain("onboard.resumed");
    expect(quietHarness.getSession()).toMatchObject({ status: "complete" });
  });

  it("records safe context updates without moving the machine until the runner applies the result", async () => {
    const harness = createHarness();
    const recorders = harness.boundary.recorders();

    const result = await runOnboardMachineWithRecordOnlySteps({
      boundary: harness.boundary,
      emitLifecycleEvent: false,
      context: {},
      handlers: {
        init: async () => {
          await recorders.recordStepComplete("preflight", {
            sandboxName: "record-only-sb",
            endpointUrl: "https://alice:secret@example.com/v1?token=secret&keep=yes",
            apiKey: "secret",
          } as SessionUpdates & { apiKey: string });
          const recorded = harness.getSession();
          expect(recorded).toMatchObject({
            sandboxName: "record-only-sb",
            endpointUrl: "https://example.com/v1?token=%3CREDACTED%3E&keep=yes",
            machine: { state: "init", revision: 0 },
            steps: { preflight: { status: "complete" } },
          });
          expect("apiKey" in recorded).toBe(false);
          return advanceTo("preflight");
        },
        ...completionHandlers(),
      },
    });

    expect(result.session).toMatchObject({
      sandboxName: "record-only-sb",
      machine: { state: "complete" },
    });
  });

  it("records failed step status before explicit failed results mark the session and machine failed", async () => {
    const harness = createHarness();
    const recorders = harness.boundary.recorders();

    const result = await runOnboardMachineWithRecordOnlySteps({
      boundary: harness.boundary,
      emitLifecycleEvent: false,
      context: {},
      handlers: {
        init: () => advanceTo("preflight"),
        preflight: async () => {
          await recorders.recordStepFailed("preflight", "Preflight failed");
          expect(harness.getSession()).toMatchObject({
            status: "in_progress",
            failure: null,
            machine: { state: "preflight", revision: 1 },
            steps: { preflight: { status: "failed", error: "Preflight failed" } },
          });
          return failOnboardMachine("Preflight failed", { step: "preflight" });
        },
      },
    });

    expect(result.session).toMatchObject({
      status: "failed",
      failure: { step: "preflight", message: "Preflight failed" },
      machine: { state: "failed", revision: 2 },
      steps: { preflight: { status: "failed", error: "Preflight failed" } },
    });
  });
});
