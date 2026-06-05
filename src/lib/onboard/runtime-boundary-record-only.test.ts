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
import { advanceTo, failOnboardMachine } from "./machine/result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./machine/runtime";
import { OnboardRuntimeBoundary } from "./runtime-boundary";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createRuntimeHarness() {
  let session: Session = createSession();
  const events: OnboardMachineEvent[] = [];
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
    markStepStarted: (stepName) =>
      updateSession((current) => {
        current.steps[stepName].status = "in_progress";
        return current;
      }),
    markStepComplete: (stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => {
        current.steps[stepName].status = "complete";
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepCompleteRecordOnly: (stepName, updates: SessionUpdates = {}) =>
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
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.steps[stepName].error = message ?? null;
        current.status = "failed";
        current.failure = { step: stepName, message: message ?? null, recordedAt: "now" };
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
    now: () => "2026-05-27T00:00:00.000Z",
  };
  return {
    boundary: new OnboardRuntimeBoundary({
      toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
      maybeForceE2eStepFailure: () => undefined,
      createRuntime: () => new OnboardRuntime(deps),
    }),
    events,
    getSession: () => cloneSession(session),
  };
}

describe("OnboardRuntimeBoundary record-only step/result pairing", () => {
  it("pairs record-only step completion with an explicit state result", async () => {
    const { boundary, events } = createRuntimeHarness();

    await boundary.recordStateResult(advanceTo("preflight"));
    const completed = await boundary.recordStepCompleteWithStateResult(
      "preflight",
      { sandboxName: "record-only-sb" },
      advanceTo("gateway", { metadata: { state: "preflight" } }),
    );

    expect(completed).toMatchObject({
      sandboxName: "record-only-sb",
      machine: { state: "gateway", revision: 2 },
      steps: { preflight: { status: "complete" } },
    });
    expect(events.map((event) => event.type)).toEqual([
      "state.exited",
      "state.entered",
      "state.exited",
      "state.entered",
    ]);
  });

  it("pairs record-only step failure with an explicit failure result", async () => {
    const { boundary, events } = createRuntimeHarness();

    await boundary.recordStateResult(advanceTo("preflight"));
    const failed = await boundary.recordStepFailedWithStateResult(
      "preflight",
      "Preflight failed",
      failOnboardMachine("Preflight failed", { step: "preflight" }),
    );

    expect(failed).toMatchObject({
      status: "failed",
      failure: { step: "preflight", message: "Preflight failed" },
      machine: { state: "failed", revision: 2 },
      steps: { preflight: { status: "failed", error: "Preflight failed" } },
    });
    expect(events.map((event) => event.type)).toEqual([
      "state.exited",
      "state.entered",
      "state.failed",
      "onboard.failed",
    ]);
  });

  it("rejects invalid explicit results before persisting record-only step completion", async () => {
    const { boundary, getSession } = createRuntimeHarness();

    await boundary.recordStateResult(advanceTo("preflight"));
    await expect(
      boundary.recordStepCompleteWithStateResult("preflight", {}, advanceTo("sandbox")),
    ).rejects.toThrow("Invalid onboarding machine transition: preflight -> sandbox");

    expect(getSession()).toMatchObject({
      machine: { state: "preflight", revision: 1 },
      steps: { preflight: { status: "pending" } },
    });
  });
});
