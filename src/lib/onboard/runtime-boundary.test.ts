// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../state/onboard-session";
import type { StepMutationOptions } from "../state/onboard-step-mutation";
import type { OnboardMachineEvent } from "./machine/events";
import { advanceTo, branchTo, completeOnboardMachine, retryTo } from "./machine/result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./machine/runtime";
import type { OnboardMachineState } from "./machine/types";
import { OnboardRuntimeBoundary } from "./runtime-boundary";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

const STEP_TO_STATE: Record<string, OnboardMachineState> = {
  preflight: "preflight",
  gateway: "gateway",
  provider_selection: "provider_selection",
  inference: "inference",
  sandbox: "sandbox",
  openclaw: "openclaw",
  agent_setup: "agent_setup",
  policies: "policies",
};

function nextStateAfterCompletedStep(
  stepName: string,
  session: Pick<Session, "agent">,
): OnboardMachineState | null {
  switch (stepName) {
    case "preflight":
      return "gateway";
    case "gateway":
      return "provider_selection";
    case "provider_selection":
      return "inference";
    case "inference":
      return "sandbox";
    case "sandbox":
      return session.agent ? "agent_setup" : "openclaw";
    case "openclaw":
    case "agent_setup":
      return "policies";
    case "policies":
      return "finalizing";
    default:
      return null;
  }
}

function transitionMachine(session: Session, state: OnboardMachineState): void {
  session.machine = {
    version: session.machine.version,
    state,
    stateEnteredAt: "2026-05-27T00:00:00.000Z",
    revision:
      session.machine.state === state ? session.machine.revision : session.machine.revision + 1,
  };
}

function shouldUpdateMachine(options: StepMutationOptions | undefined): boolean {
  return options?.updateMachine !== false;
}

function createRuntimeHarness(overrides: Partial<Session> = {}) {
  let session: Session | null = createSession(overrides);
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
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "in_progress";
        step.startedAt = "2026-05-27T00:00:00.000Z";
        step.completedAt = null;
        step.error = null;
        current.lastStepStarted = stepName;
        current.status = "in_progress";
        current.failure = null;
        const state = STEP_TO_STATE[stepName];
        if (state && shouldUpdateMachine(options)) transitionMachine(current, state);
        return current;
      });
    },
    markStepComplete: (stepName, updates: SessionUpdates = {}, options) => {
      stepOptionCalls.push({ method: "markStepComplete", options });
      return updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "complete";
        step.completedAt = "2026-05-27T00:00:00.000Z";
        step.error = null;
        current.lastCompletedStep = stepName;
        current.failure = null;
        Object.assign(current, filterSafeUpdates(updates));
        const nextState = nextStateAfterCompletedStep(stepName, current);
        if (nextState && shouldUpdateMachine(options)) transitionMachine(current, nextState);
        return current;
      });
    },
    markStepCompleteRecordOnly: () => cloneSession(session ?? createSession()),
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message, options) => {
      stepOptionCalls.push({ method: "markStepFailed", options });
      return updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.failure = shouldUpdateMachine(options)
          ? { step: stepName, message: message ?? null, recordedAt: "now" }
          : current.failure;
        return current;
      });
    },
    markStepFailedRecordOnly: () => cloneSession(session ?? createSession()),
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
    getSession: () => cloneSession(session ?? createSession()),
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

  it("defaults boundary step recorders to record-only machine mutations", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.startRecordedStep("preflight");
    await boundary.recordStepComplete("preflight");
    await boundary.recordStepFailed("gateway", "boom");

    expect(harness.stepOptionCalls).toEqual([
      { method: "markStepStarted", options: { updateMachine: false } },
      { method: "markStepComplete", options: { updateMachine: false } },
      { method: "markStepFailed", options: { updateMachine: false } },
    ]);
  });

  it("keeps default boundary step recorders from advancing the machine", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.startRecordedStep("preflight");
    expect(harness.getSession().machine.state).toBe("init");
    await boundary.recordStepComplete("preflight");
    expect(harness.getSession().machine.state).toBe("init");

    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("preflight", { metadata: { state: "init" } }),
    );
    expect(harness.getSession().machine.state).toBe("preflight");
  });

  it("forwards configured step mutation options through boundary recorders", async () => {
    const harness = createRuntimeHarness();
    const legacyOptions = { updateMachine: true };
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
      stepMutationOptions: legacyOptions,
    });

    await boundary.startRecordedStep("preflight");
    await boundary.recordStepComplete("preflight");
    await boundary.recordStepFailed("gateway", "boom");

    expect(harness.stepOptionCalls).toEqual([
      { method: "markStepStarted", options: legacyOptions },
      { method: "markStepComplete", options: legacyOptions },
      { method: "markStepFailed", options: legacyOptions },
    ]);
    expect(harness.getSession().machine.state).toBe("gateway");
  });

  it("applies state results unless legacy step helpers already advanced the machine", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("preflight", { metadata: { state: "init" } }),
    );
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("preflight", { metadata: { state: "init" } }),
    );
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("gateway", { metadata: { state: "preflight" } }),
    );

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

    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("gateway", { metadata: { state: "preflight" } }),
    );

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

  it("allows skipped transition results whose updates are all undefined", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    const session = await boundary.recordStateResultWithStepCompatibility(
      advanceTo("preflight", {
        metadata: { state: "missing" },
        updates: { provider: undefined, model: undefined },
      }),
    );

    expect(session.machine.state).toBe("init");
    expect(harness.events[0]).toMatchObject({
      type: "state.result.skipped",
      state: "init",
      metadata: {
        reason: "source_state_mismatch",
        currentState: "init",
        targetState: "preflight",
        sourceState: "missing",
      },
    });
  });

  it("records live legacy step/result compatibility through provider retry and finalization", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
      stepMutationOptions: { updateMachine: true },
    });

    await boundary.startRecordedStep("preflight");
    await boundary.recordStepComplete("preflight");
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("gateway", { metadata: { state: "preflight" } }),
    );

    await boundary.startRecordedStep("gateway");
    await boundary.recordStepComplete("gateway");
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("provider_selection", { metadata: { state: "gateway" } }),
    );

    await boundary.startRecordedStep("provider_selection");
    await boundary.recordStepComplete("provider_selection", {
      provider: "bad",
      model: "bad-model",
    });
    await boundary.startRecordedStep("inference", { provider: "bad", model: "bad-model" });
    const retryResult = retryTo("provider_selection", {
      metadata: {
        state: "inference",
        provider: "bad",
        model: "bad-model",
        reason: "selection_retry",
      },
    });
    await boundary.startRecordedStep("provider_selection");
    await boundary.recordStepComplete("provider_selection", {
      provider: "nvidia",
      model: "nemotron",
    });
    await boundary.startRecordedStep("inference", { provider: "nvidia", model: "nemotron" });
    await boundary.recordStepComplete("inference", { provider: "nvidia", model: "nemotron" });
    await boundary.recordStateResultWithStepCompatibility(retryResult);
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("sandbox", {
        metadata: { state: "inference", provider: "nvidia", model: "nemotron" },
      }),
    );

    await boundary.startRecordedStep("sandbox");
    await boundary.recordStepComplete("sandbox", { sandboxName: "openclaw-sb" });
    await boundary.recordStateResultWithStepCompatibility(
      branchTo("openclaw", {
        metadata: { state: "sandbox", sandboxName: "openclaw-sb", agent: "openclaw" },
      }),
    );

    await boundary.startRecordedStep("openclaw");
    await boundary.recordStepComplete("openclaw");
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("policies", { metadata: { state: "openclaw" } }),
    );

    await boundary.startRecordedStep("policies");
    await boundary.recordStepComplete("policies", { policyPresets: ["github"] });
    await boundary.recordStateResultWithStepCompatibility(
      advanceTo("finalizing", { metadata: { state: "policies" } }),
    );

    await boundary.recordPostVerifyStarted();
    const completed = await boundary.recordStateResultWithStepCompatibility(
      completeOnboardMachine(
        { sandboxName: "openclaw-sb", provider: "nvidia", model: "nemotron" },
        { state: "finalizing" },
      ),
    );

    const skipped = harness.events.filter((event) => event.type === "state.result.skipped");
    expect(skipped.map((event) => event.metadata.targetState)).toEqual([
      "gateway",
      "provider_selection",
      "provider_selection",
      "sandbox",
      "openclaw",
      "policies",
      "finalizing",
    ]);
    expect(skipped[2]).toMatchObject({
      state: "sandbox",
      metadata: {
        reason: "source_state_mismatch",
        currentState: "sandbox",
        sourceState: "inference",
        targetState: "provider_selection",
      },
    });
    expect(completed).toMatchObject({
      status: "complete",
      machine: { state: "complete" },
      sandboxName: "openclaw-sb",
      provider: "nvidia",
      model: "nemotron",
    });
  });

  it("records sandbox branch compatibility for agent setup sandboxes", async () => {
    const harness = createRuntimeHarness({ agent: "hermes" });
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
      stepMutationOptions: { updateMachine: true },
    });

    await boundary.recordStateResult(advanceTo("preflight"));
    await boundary.recordStateResult(advanceTo("gateway"));
    await boundary.recordStateResult(advanceTo("provider_selection"));
    await boundary.recordStateResult(advanceTo("inference"));
    await boundary.recordStateResult(advanceTo("sandbox"));
    await boundary.startRecordedStep("sandbox");
    await boundary.recordStepComplete("sandbox", { sandboxName: "hermes-sb" });

    const session = await boundary.recordStateResultWithStepCompatibility(
      branchTo("agent_setup", {
        metadata: { state: "sandbox", sandboxName: "hermes-sb", agent: "hermes" },
      }),
    );

    expect(session.machine.state).toBe("agent_setup");
    expect(harness.events.at(-1)).toMatchObject({
      type: "state.result.skipped",
      state: "agent_setup",
      metadata: {
        reason: "already_at_target",
        currentState: "agent_setup",
        targetState: "agent_setup",
      },
    });
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
