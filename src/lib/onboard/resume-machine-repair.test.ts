// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../state/onboard-session";
import { advanceTo, branchTo } from "./machine/result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./machine/runtime";
import {
  repairResumeMachineSnapshot,
  resumeMachineState,
} from "./resume-machine-repair";
import { OnboardRuntimeBoundary } from "./runtime-boundary";

/**
 * Builds a failed durable session while letting each test set the interrupted step.
 */
function createFailedSession(mutator: (session: Session) => void): Session {
  const session = createSession({
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state: "failed",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 7,
    },
    status: "failed",
    failure: {
      step: null,
      message: "interrupted",
      recordedAt: "2026-06-01T00:00:00.000Z",
    },
  });
  mutator(session);
  return session;
}

/**
 * Round-trips sessions through normalization to match persisted runtime state.
 */
function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

/**
 * Creates a memory-backed runtime boundary with record-only step mutations.
 */
function createBoundaryHarness(initial: Session) {
  let session = cloneSession(initial);
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    const current = cloneSession(session);
    session = cloneSession(mutator(current) ?? current);
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
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
        return current;
      }),
    filterSafeUpdates,
    emitEvent: () => undefined,
    now: () => "2026-06-01T00:02:00.000Z",
  };
  const boundary = new OnboardRuntimeBoundary({
    toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
    maybeForceE2eStepFailure: () => undefined,
    createRuntime: () => new OnboardRuntime(deps),
    stepMutationOptions: { updateMachine: false },
  });
  return { boundary, getSession: () => cloneSession(session) };
}

/**
 * Replays the live resume sequence from failed snapshot repair through completion.
 */
async function runRecordOnlyResumeSequence(initial: Session): Promise<Session> {
  repairResumeMachineSnapshot(initial, "2026-06-01T00:01:00.000Z");
  initial.failure = null;
  initial.status = "in_progress";
  const { boundary, getSession } = createBoundaryHarness(initial);
  await boundary.recordOnboardStarted(true);
  await boundary.recordStateResultsWithStepCompatibility([
    advanceTo("preflight", { metadata: { state: "init" } }),
    advanceTo("gateway", { metadata: { state: "preflight" } }),
    advanceTo("provider_selection", { metadata: { state: "gateway" } }),
    advanceTo("inference", { metadata: { state: "provider_selection" } }),
    advanceTo("sandbox", { metadata: { state: "inference" } }),
    branchTo("openclaw", { metadata: { state: "sandbox" } }),
    advanceTo("policies", { metadata: { state: "openclaw" } }),
    advanceTo("finalizing", { metadata: { state: "policies" } }),
  ]);
  await boundary.recordSessionComplete();
  return getSession();
}

describe("resume machine repair", () => {
  it("resumes a failed preflight session from preflight", () => {
    const session = createFailedSession((current) => {
      current.failure = {
        step: "preflight",
        message: "Docker is unavailable",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
      current.lastStepStarted = "preflight";
      current.steps.preflight.status = "failed";
    });

    expect(resumeMachineState(session)).toBe("preflight");
    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "preflight",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 8,
    });
  });

  it("uses the failed step before the last completed step", () => {
    const session = createFailedSession((current) => {
      current.lastCompletedStep = "provider_selection";
      current.steps.provider_selection.status = "complete";
      current.lastStepStarted = "inference";
      current.steps.inference.status = "failed";
      current.failure = {
        step: "inference",
        message: "route validation failed",
        recordedAt: "2026-06-01T00:00:00.000Z",
      };
    });

    expect(resumeMachineState(session)).toBe("inference");
  });

  it("derives the branch state after sandbox when no failed step is recorded", () => {
    const session = createFailedSession((current) => {
      current.agent = "hermes";
      current.lastCompletedStep = "sandbox";
      current.steps.sandbox.status = "complete";
      current.failure = null;
    });

    expect(resumeMachineState(session)).toBe("agent_setup");
  });

  it("leaves nonterminal snapshots untouched", () => {
    const session = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "gateway",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 3,
      },
    });

    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "gateway",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 3,
    });
  });

  it("repairs a complete snapshot reopened by rebuild from the last completed step", () => {
    const session = createSession({
      resumable: true,
      status: "in_progress",
      lastCompletedStep: "gateway",
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "complete",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 9,
      },
    });
    session.steps.preflight.status = "complete";
    session.steps.gateway.status = "complete";

    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "provider_selection",
      stateEnteredAt: "2026-06-01T00:01:00.000Z",
      revision: 10,
    });
  });

  it("leaves a non-resumable complete snapshot untouched", () => {
    const session = createSession({
      lastCompletedStep: "policies",
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "complete",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 5,
      },
    });
    session.resumable = false;
    session.status = "complete";

    repairResumeMachineSnapshot(session, "2026-06-01T00:01:00.000Z");

    expect(session.machine).toEqual({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "complete",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 5,
    });
  });

  it.each([
    ["preflight", "preflight", null],
    ["gateway", "gateway", "preflight"],
    ["inference", "inference", "provider_selection"],
  ] as const)(
    "lets record-only resume complete from failed %s",
    async (_name, failedStep, completedStep) => {
      const session = createFailedSession((current) => {
        current.failure = {
          step: failedStep,
          message: `${failedStep} failed`,
          recordedAt: "2026-06-01T00:00:00.000Z",
        };
        current.lastStepStarted = failedStep;
        current.steps[failedStep].status = "failed";
        if (completedStep) {
          current.lastCompletedStep = completedStep;
          current.steps[completedStep].status = "complete";
        }
      });

      const completed = await runRecordOnlyResumeSequence(session);

      expect(completed).toMatchObject({
        status: "complete",
        failure: null,
        machine: { state: "complete" },
      });
    },
  );

  it.each(["gateway", "policies"] as const)(
    "lets record-only resume complete from a reopened complete snapshot after %s",
    async (completedStep) => {
      const session = createSession({
        resumable: true,
        status: "in_progress",
        lastCompletedStep: completedStep,
        machine: {
          version: MACHINE_SNAPSHOT_VERSION,
          state: "complete",
          stateEnteredAt: "2026-06-01T00:00:00.000Z",
          revision: 7,
        },
      });
      session.steps[completedStep].status = "complete";

      const completed = await runRecordOnlyResumeSequence(session);

      expect(completed).toMatchObject({
        status: "complete",
        failure: null,
        machine: { state: "complete" },
      });
    },
  );
});
