// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Path-level characterization traces for the onboarding machine (#6225): the
 * ORDERED event streams a runner-driven pass emits — coverage the unit suites
 * lack (`transitions.test.ts` owns the legal-transition table,
 * `runtime.test.ts` pins per-operation event shapes, `runner.test.ts` pins
 * handler sequencing without observing events). Descriptive, not
 * aspirational: update a pin in the same PR that changes the ordering.
 * Recovery-path semantics (edges leaving terminal `failed`, the legacy
 * step-mutation bridge) stay out of scope and are owned by #6227.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type OnboardMachineSnapshot,
  type Session,
  type SessionUpdates,
  type StepState,
  sanitizeFailure,
} from "../../state/onboard-session";
import type { OnboardMachineEvent } from "./events";
import { handleSandboxState } from "./handlers/sandbox";
import { baseOptions, createDeps } from "./handlers/sandbox-test-fixtures";
import { advanceTo, branchTo, completeOnboardMachine, failOnboardMachine } from "./result";
import { type OnboardStateHandlers, runOnboardMachine } from "./runner";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import type { OnboardMachineState } from "./types";

const NOW = "2026-07-04T00:00:00.000Z";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function machineAt(state: OnboardMachineState, revision = 0): OnboardMachineSnapshot {
  return { version: MACHINE_SNAPSHOT_VERSION, state, stateEnteredAt: NOW, revision };
}

function completedStep(): StepState {
  return { status: "complete", startedAt: NOW, completedAt: NOW, error: null };
}

function createTracedRuntime(initialSession: Session = createSession()) {
  let session = cloneSession(initialSession);
  const events: OnboardMachineEvent[] = [];
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    // Fall back to the mutated draft, never the outer `session`: void-returning
    // mutators edit the draft in place and their edits must persist.
    const draft = cloneSession(session);
    const next = mutator(draft) ?? draft;
    session = cloneSession(next);
    return cloneSession(session);
  };
  const applySafeUpdates = (updates: SessionUpdates = {}): Session =>
    updateSession((current) => {
      Object.assign(current, filterSafeUpdates(updates));
    });
  const deps: OnboardRuntimeDeps = {
    loadSession: () => cloneSession(session),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: () => cloneSession(session),
    markStepComplete: (_stepName, updates) => applySafeUpdates(updates),
    markStepCompleteRecordOnly: (_stepName, updates) => applySafeUpdates(updates),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.status = "failed";
        current.failure = sanitizeFailure({ step: stepName, message, recordedAt: NOW });
      }),
    markStepFailedRecordOnly: () => cloneSession(session),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
      }),
    filterSafeUpdates,
    emitEvent: (event) => events.push(event),
    now: () => NOW,
  };
  return { runtime: new OnboardRuntime(deps), events, updateSession };
}

function traceOf(events: readonly OnboardMachineEvent[]): string[] {
  return events.map((event) => `${event.type}:${event.state}`);
}

function fullRunHandlers(
  overrides: Partial<OnboardStateHandlers<null>> = {},
): OnboardStateHandlers<null> {
  return {
    init: () => advanceTo("preflight"),
    preflight: () => advanceTo("gateway"),
    gateway: () => advanceTo("provider_selection"),
    provider_selection: () => advanceTo("inference"),
    inference: () => advanceTo("sandbox"),
    sandbox: () => branchTo("openclaw", { updates: { sandboxName: "my-assistant" } }),
    openclaw: () => advanceTo("policies"),
    policies: () => advanceTo("finalizing"),
    finalizing: () => advanceTo("post_verify"),
    post_verify: () => completeOnboardMachine(),
    ...overrides,
  };
}

describe("onboard machine lifecycle traces (#6225)", () => {
  it("emits the fresh-run lifecycle event stream in canonical order (#6225)", async () => {
    const { runtime, events } = createTracedRuntime();
    await runtime.start();

    const run = await runOnboardMachine({ context: null, runtime, handlers: fullRunHandlers() });

    expect(run.session).toMatchObject({
      status: "complete",
      resumable: false,
      sandboxName: "my-assistant",
      machine: { state: "complete", revision: 10 },
    });
    // Context updates are announced from the source state before the state
    // transition itself (`context.updated:sandbox` precedes `state.exited:sandbox`).
    expect(traceOf(events)).toEqual([
      "onboard.started:init",
      "state.exited:init",
      "state.entered:preflight",
      "state.exited:preflight",
      "state.entered:gateway",
      "state.exited:gateway",
      "state.entered:provider_selection",
      "state.exited:provider_selection",
      "state.entered:inference",
      "state.exited:inference",
      "state.entered:sandbox",
      "context.updated:sandbox",
      "state.exited:sandbox",
      "state.entered:openclaw",
      "state.exited:openclaw",
      "state.entered:policies",
      "state.exited:policies",
      "state.entered:finalizing",
      "state.exited:finalizing",
      "state.entered:post_verify",
      "state.completed:post_verify",
      "state.entered:complete",
      "onboard.completed:complete",
    ]);
    expect(events[events.length - 1]).toMatchObject({
      type: "onboard.completed",
      context: { sandboxName: "my-assistant" },
    });
  });

  it("resumes at openclaw without re-entering completed states (#6225)", async () => {
    const resumedSession = createSession({
      sandboxName: "my-assistant",
      provider: "nvidia",
      model: "model",
      lastCompletedStep: "sandbox",
      machine: machineAt("openclaw", 6),
      steps: { sandbox: completedStep() },
    });
    const { runtime, events } = createTracedRuntime(resumedSession);
    const { openclaw, policies, finalizing, post_verify } = fullRunHandlers();

    await runtime.start({ resumed: true });
    // No handlers exist for the already-completed states — the runner would
    // throw MissingOnboardStateHandlerError if it re-entered any of them.
    const run = await runOnboardMachine({
      context: null,
      runtime,
      handlers: { openclaw, policies, finalizing, post_verify },
    });

    expect(traceOf(events)).toEqual([
      "onboard.resumed:openclaw",
      "state.exited:openclaw",
      "state.entered:policies",
      "state.exited:policies",
      "state.entered:finalizing",
      "state.exited:finalizing",
      "state.entered:post_verify",
      "state.completed:post_verify",
      "state.entered:complete",
      "onboard.completed:complete",
    ]);
    // The resume announcement carries the sanitized session context.
    expect(events[0]).toMatchObject({
      type: "onboard.resumed",
      context: { sandboxName: "my-assistant", provider: "nvidia", model: "model" },
    });
    expect(run.session).toMatchObject({
      status: "complete",
      resumable: false,
      sandboxName: "my-assistant",
      lastCompletedStep: "sandbox",
      machine: { state: "complete", revision: 10 },
    });
    expect(run.session.steps.sandbox.status).toBe("complete");
  });

  it("repairs and recreates through the sandbox handler before branching (#6225)", async () => {
    const resumedSession = createSession({
      sandboxName: "my-assistant",
      lastCompletedStep: "sandbox",
      machine: machineAt("sandbox", 5),
      steps: { sandbox: completedStep() },
    });
    const { runtime, events, updateSession } = createTracedRuntime(resumedSession);
    const { calls, deps } = createDeps({
      getSandboxReuseState: () => "not_ready",
      updateSession,
      recordRepairEvent: (type, options) => runtime.emitRepairEvent(type, options),
      recordStepComplete: async (_stepName, updates) =>
        updateSession((current) => {
          Object.assign(current, filterSafeUpdates(updates));
        }),
    });
    await runtime.start({ resumed: true });
    const session = await runtime.session();

    const run = await runOnboardMachine({
      context: null,
      runtime,
      handlers: {
        sandbox: async () => {
          const handled = await handleSandboxState({
            ...baseOptions(deps, session),
            resume: true,
            session,
            sandboxName: "my-assistant",
          });
          return handled.stateResult;
        },
      },
      stopStates: ["openclaw"],
    });

    expect(calls.repairSandbox).toHaveBeenCalledWith("my-assistant");
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(traceOf(events)).toEqual([
      "onboard.resumed:sandbox",
      "state.repair.started:sandbox",
      "state.repair.completed:sandbox",
      "state.exited:sandbox",
      "state.entered:openclaw",
    ]);
    expect(run.session).toMatchObject({
      status: "in_progress",
      sandboxName: "my-assistant",
      machine: { state: "openclaw", revision: 6 },
    });
  });

  it("stops at the failing inference step and records the failure envelope (#6225)", async () => {
    const { runtime, events } = createTracedRuntime();
    const sandboxHandler = vi.fn(() => branchTo("openclaw"));
    await runtime.start();

    const run = await runOnboardMachine({
      context: null,
      runtime,
      handlers: fullRunHandlers({
        inference: () => failOnboardMachine("model probe failed", { step: "inference" }),
        sandbox: sandboxHandler,
      }),
    });

    expect(sandboxHandler).not.toHaveBeenCalled();
    // A failed run stays resumable — `onboard --resume` recovery relies on
    // the failure transition leaving `resumable` untouched.
    expect(run.session).toMatchObject({
      status: "failed",
      resumable: true,
      failure: { step: "inference", message: "model probe failed", recordedAt: NOW },
      machine: { state: "failed", revision: 5 },
    });
    expect(traceOf(events)).toEqual([
      "onboard.started:init",
      "state.exited:init",
      "state.entered:preflight",
      "state.exited:preflight",
      "state.entered:gateway",
      "state.exited:gateway",
      "state.entered:provider_selection",
      "state.exited:provider_selection",
      "state.entered:inference",
      "state.failed:inference",
      "onboard.failed:failed",
    ]);
    expect(events[events.length - 2]).toMatchObject({
      type: "state.failed",
      state: "inference",
      step: "inference",
      error: "model probe failed",
    });
  });
});
