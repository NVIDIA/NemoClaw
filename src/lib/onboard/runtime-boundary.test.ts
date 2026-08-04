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
import type { OnboardMachineEvent } from "./machine/events";
import {
  advanceTo,
  branchTo,
  completeOnboardMachine,
  failOnboardMachine,
  pauseOnboardMachine,
  retryTo,
} from "./machine/result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./machine/runtime";
import {
  InvalidOnboardMachineTransitionError,
  OnboardInterruptedError,
} from "./machine/transitions";
import { OnboardRuntimeBoundary } from "./runtime-boundary";
import { applySessionRecovery } from "./session-recovery";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createRuntimeHarness(overrides: Partial<Session> = {}) {
  let session: Session | null = createSession(overrides);
  const events: OnboardMachineEvent[] = [];
  const stepCalls: string[] = [];
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
    markStepStarted: (stepName) => {
      stepCalls.push("markStepStarted");
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
        return current;
      });
    },
    markStepComplete: (stepName, updates: SessionUpdates = {}) => {
      stepCalls.push("markStepComplete");
      return updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "complete";
        step.completedAt = "2026-05-27T00:00:00.000Z";
        step.error = null;
        current.lastCompletedStep = stepName;
        current.failure = null;
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      });
    },
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message) => {
      stepCalls.push("markStepFailed");
      return updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.steps[stepName].error = message ?? null;
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
    stepCalls,
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

  it("dispatches a durable recovery receipt after resume and clears it on transition (#6227)", async () => {
    const recovered = createSession({
      resumable: true,
      status: "in_progress",
      lastCompletedStep: "gateway",
      machine: {
        version: 1,
        state: "complete",
        stateEnteredAt: "2026-05-27T00:00:00.000Z",
        revision: 9,
      },
    });
    recovered.steps.preflight.status = "complete";
    recovered.steps.gateway.status = "complete";
    applySessionRecovery(recovered, "2026-05-27T00:01:00.000Z");
    const receiptId = recovered.machine.recoveryReceipt?.id;
    const harness = createRuntimeHarness(recovered);
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordOnboardStarted(true);

    expect(harness.events.map((event) => event.type)).toEqual([
      "onboard.resumed",
      "state.repair.completed",
    ]);
    expect(harness.events[1]).toMatchObject({
      state: "provider_selection",
      metadata: {
        reason: "reopened_complete_snapshot",
        entry: "provider_selection",
        receiptId,
        revision: 10,
      },
    });

    await boundary.recordStateResult(
      advanceTo("inference", { metadata: { state: "provider_selection" } }),
    );
    expect(harness.getSession().machine.recoveryReceipt).toBeUndefined();

    await boundary.recordOnboardStarted(true);
    expect(harness.events.filter((event) => event.type === "state.repair.completed")).toHaveLength(
      1,
    );
  });

  it("keeps step status writes separate from runtime transitions", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.startRecordedStep("preflight");
    await boundary.recordStepComplete("preflight");
    await boundary.recordStepFailed("gateway", "boom");

    expect(harness.stepCalls).toEqual(["markStepStarted", "markStepComplete", "markStepFailed"]);
    expect(harness.getSession()).toMatchObject({
      machine: { state: "init", revision: 0 },
      steps: { preflight: { status: "complete" }, gateway: { status: "failed" } },
    });
  });

  it("applies each explicit transition exactly once", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordStateResult(advanceTo("preflight", { metadata: { state: "init" } }));

    expect(harness.getSession().machine).toMatchObject({ state: "preflight", revision: 1 });
    expect(harness.events.map((event) => event.type)).toEqual(["state.exited", "state.entered"]);
  });

  it("rejects a stale explicit transition before mutation", async () => {
    const harness = createRuntimeHarness();
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await expect(
      boundary.recordStateResult(advanceTo("gateway", { metadata: { state: "preflight" } })),
    ).rejects.toThrow("Onboarding state result source mismatch: preflight != init");
    expect(harness.getSession().machine).toMatchObject({ state: "init", revision: 0 });
    expect(harness.events).toHaveLength(0);
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

describe("onboarding interrupted while a step is in flight (#7982)", () => {
  function failedAtSandbox(interrupted: boolean) {
    const harness = createRuntimeHarness({
      status: "failed",
      lastStepStarted: "sandbox",
      failure: {
        step: "sandbox",
        message: interrupted
          ? "Onboarding exited before the step completed."
          : "Rebuild recreate failed",
        recordedAt: "2026-05-27T00:00:00.000Z",
        interrupted,
      },
      machine: {
        version: 1,
        state: "failed",
        stateEnteredAt: "2026-05-27T00:00:00.000Z",
        revision: 5,
      },
    });
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });
    return { boundary, harness };
  }

  function interruptedAtSandbox() {
    return failedAtSandbox(true);
  }

  it("reports the sandbox branch as interrupted rather than an invalid transition", async () => {
    const { boundary, harness } = interruptedAtSandbox();

    const applied = boundary.recordStateResult(
      branchTo("openclaw", { metadata: { state: "sandbox" } }),
    );

    await expect(applied).rejects.toThrow(OnboardInterruptedError);
    await expect(applied).rejects.not.toThrow(InvalidOnboardMachineTransitionError);
    await expect(applied).rejects.toThrow(/during the sandbox step/);
    await expect(applied).rejects.toThrow(/continue to openclaw/);
    expect(harness.getSession().machine).toMatchObject({ state: "failed", revision: 5 });
    expect(harness.events).toHaveLength(0);
  });

  it("reports an interrupt recorded by another process without an in-process latch", async () => {
    const { boundary, harness } = interruptedAtSandbox();

    const applied = boundary.recordStateResult(
      branchTo("openclaw", { metadata: { state: "sandbox" } }),
    );

    await expect(applied).rejects.toThrow(OnboardInterruptedError);
    await expect(applied).rejects.toThrow(/during the sandbox step/);
    expect(harness.getSession().machine).toMatchObject({ state: "failed", revision: 5 });
  });

  it("reports an ordinary failed session as an invalid transition, not an interrupt", async () => {
    const { boundary, harness } = failedAtSandbox(false);

    const applied = boundary.recordStateResult(
      branchTo("openclaw", { metadata: { state: "sandbox" } }),
    );

    await expect(applied).rejects.toThrow(InvalidOnboardMachineTransitionError);
    await expect(applied).rejects.not.toThrow(OnboardInterruptedError);
    expect(harness.getSession().machine).toMatchObject({ state: "failed", revision: 5 });
  });

  it("rejects completing an interrupted session through recordSessionComplete", async () => {
    const { boundary, harness } = interruptedAtSandbox();

    await expect(boundary.recordSessionComplete()).rejects.toThrow(OnboardInterruptedError);
    expect(harness.getSession().machine).toMatchObject({ state: "failed", revision: 5 });
  });

  it("reports an interrupted finalization rather than an invalid completion", async () => {
    const { boundary } = interruptedAtSandbox();

    await expect(boundary.recordStateResult(completeOnboardMachine())).rejects.toThrow(
      OnboardInterruptedError,
    );
  });

  it("still applies a legal branch when no interrupt was recorded", async () => {
    const harness = createRuntimeHarness({
      lastStepStarted: "sandbox",
      machine: {
        version: 1,
        state: "sandbox",
        stateEnteredAt: "2026-05-27T00:00:00.000Z",
        revision: 5,
      },
    });
    const boundary = new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: harness.createRuntime,
    });

    await boundary.recordStateResult(branchTo("openclaw", { metadata: { state: "sandbox" } }));

    expect(harness.getSession().machine).toMatchObject({ state: "openclaw", revision: 6 });
  });
});
