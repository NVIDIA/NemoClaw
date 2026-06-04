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
} from "../state/onboard-session";
import type { OnboardMachineEvent } from "./machine/events";
import { advanceTo } from "./machine/result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./machine/runtime";
import { OnboardRuntimeBoundary } from "./runtime-boundary";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createRuntimeHarness() {
  let session: Session | null = createSession();
  const events: OnboardMachineEvent[] = [];
  const stepOptionCalls: Array<{ method: string; options: StepMutationOptions | undefined }> = [];
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    const current = session ? cloneSession(session) : createSession();
    session = cloneSession(mutator(current) ?? current);
    return cloneSession(session);
  };
  const deps: OnboardRuntimeDeps = {
    loadSession: () => (session ? cloneSession(session) : null),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: (stepName, options) => {
      stepOptionCalls.push({ method: "markStepStarted", options });
      return updateSession((current) => {
        current.steps[stepName].status = "in_progress";
        return current;
      });
    },
    markStepComplete: (stepName, updates: SessionUpdates = {}, options) => {
      stepOptionCalls.push({ method: "markStepComplete", options });
      return updateSession((current) => {
        current.steps[stepName].status = "complete";
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      });
    },
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message, options) => {
      stepOptionCalls.push({ method: "markStepFailed", options });
      return updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.failure = { step: stepName, message: message ?? null, recordedAt: "now" };
        return current;
      });
    },
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        return current;
      }),
    filterSafeUpdates,
    emitEvent: (event) => events.push(event),
    now: () => "2026-05-27T00:00:00.000Z",
  };
  return {
    createRuntime: () => new OnboardRuntime(deps),
    events,
    stepOptionCalls,
  };
}

describe("OnboardRuntimeBoundary", () => {
  it("records started and resumed lifecycle events through the runtime", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordOnboardStarted(false);
    await boundary.recordOnboardStarted(true);

    expect(harness.events.map((event) => event.type)).toEqual([
      "onboard.started",
      "onboard.resumed",
    ]);
    expect(harness.events[0]).toMatchObject({ state: "init" });
    expect(harness.events[1]).toMatchObject({ state: "init" });
  });

  it("forwards configured step mutation options through boundary recorders", async () => {
    const harness = createRuntimeHarness();
    const recordOnlyOptions = { updateMachine: false };
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
      stepMutationOptions: recordOnlyOptions,
    });

    await boundary.startRecordedStep("preflight");
    await boundary.recordStepComplete("preflight");
    await boundary.recordStepFailed("gateway", "boom");

    expect(harness.stepOptionCalls).toEqual([
      { method: "markStepStarted", options: recordOnlyOptions },
      { method: "markStepComplete", options: recordOnlyOptions },
      { method: "markStepFailed", options: recordOnlyOptions },
    ]);
  });

  it("applies state results unless legacy step helpers already advanced the machine", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordStateResultWithStepCompatibility(advanceTo("preflight", { metadata: { state: "init" } }));
    await boundary.recordStateResultWithStepCompatibility(advanceTo("preflight", { metadata: { state: "init" } }));
    await boundary.recordStateResultWithStepCompatibility(advanceTo("gateway", { metadata: { state: "preflight" } }));

    expect(harness.events.map((event) => event.type)).toEqual([
      "state.exited",
      "state.entered",
      "state.result.skipped",
      "state.exited",
      "state.entered",
    ]);
    expect(harness.events[1]).toMatchObject({ state: "preflight" });
    expect(harness.events[2]).toMatchObject({
      state: "preflight",
      metadata: {
        reason: "already_at_target",
        currentState: "preflight",
        targetState: "preflight",
      },
    });
    expect(harness.events[4]).toMatchObject({ state: "gateway" });
  });

  it("emits diagnostics for stale compatible state results", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordStateResultWithStepCompatibility(advanceTo("gateway", { metadata: { state: "preflight" } }));

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      type: "state.result.skipped",
      state: "init",
      metadata: {
        reason: "source_state_mismatch",
        currentState: "init",
        targetState: "gateway",
        sourceState: "preflight",
      },
    });
  });

  it("rejects skipped transition results that carry context updates", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await expect(
      boundary.recordStateResultWithStepCompatibility(
        advanceTo("preflight", { metadata: { state: "missing" }, updates: { provider: "nvidia" } }),
      ),
    ).rejects.toThrow("Cannot skip onboarding state result with context updates");
  });

  it("records resume conflict diagnostics through the runtime", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordResumeConflict({
      field: "sandbox",
      recorded: "old-sandbox",
      requested: "new-sandbox",
    });

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      type: "resume.conflict",
      metadata: { field: "sandbox", recorded: "old-sandbox", requested: "new-sandbox" },
    });
  });
});
