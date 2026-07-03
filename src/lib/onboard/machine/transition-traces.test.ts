// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Characterization traces for the onboarding machine (#6225).
 *
 * These tests pin CURRENT behavior on main as a regression baseline for the
 * lifecycle-contract mapping in epic #6224. They are descriptive, not
 * aspirational: when a pinned ordering changes intentionally, update the pin
 * in the same PR that changes the behavior.
 *
 * Deliberately OUT of scope here: the recovery-path semantics that open PR
 * #6253 is rewriting. This file does not pin the legality of transitions
 * leaving the terminal `failed` state (for example `failed -> <agent state>`
 * repair edges) and does not pin the legacy step-mutation compatibility
 * bridge (`LEGACY_MACHINE_STEP_MUTATION_OPTIONS` or the runtime-boundary
 * stale-result skip rules) — #6253 pins those in its own tests. The exact
 * full-table equality pin also stays in `transitions.test.ts`; this file
 * asserts the canonical edges positively so additive recovery edges do not
 * invalidate the trace baseline.
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
import {
  advanceTo,
  branchTo,
  completeOnboardMachine,
  failOnboardMachine,
  retryTo,
  transitionTo,
} from "./result";
import { type OnboardStateHandlers, runOnboardMachine } from "./runner";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import {
  assertValidOnboardMachineTransition,
  canTransitionOnboardMachineState,
  getOnboardMachineTransition,
  InvalidOnboardMachineTransitionError,
  ONBOARD_MACHINE_DIRECT_TRANSITIONS,
  ONBOARD_MACHINE_TRANSITIONS,
} from "./transitions";
import {
  ONBOARD_MACHINE_STATES,
  ONBOARD_NON_TERMINAL_MACHINE_STATES,
  type OnboardMachineState,
  type OnboardMachineTransition,
} from "./types";

const NOW = "2026-07-04T00:00:00.000Z";

interface TraceContext {
  attempts: number;
  visited: string[];
}

function traceContext(): TraceContext {
  return { attempts: 0, visited: [] };
}

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
    const next = mutator(cloneSession(session)) ?? session;
    session = cloneSession(next);
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
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepCompleteRecordOnly: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.status = "failed";
        current.failure = sanitizeFailure({ step: stepName, message, recordedAt: NOW });
        return current;
      }),
    markStepFailedRecordOnly: () => cloneSession(session),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
        return current;
      }),
    filterSafeUpdates,
    emitEvent: (event) => {
      events.push(event);
    },
    now: () => NOW,
  };
  return { runtime: new OnboardRuntime(deps), events };
}

function traceOf(events: readonly OnboardMachineEvent[]): string[] {
  return events.map((event) => `${event.type}:${event.state}`);
}

const recordVisited = ({
  context,
  state,
}: {
  context: TraceContext;
  state: OnboardMachineState;
}): TraceContext => ({
  attempts: state === "inference" ? context.attempts + 1 : context.attempts,
  visited: [...context.visited, state],
});

function fullRunHandlers(
  overrides: Partial<OnboardStateHandlers<TraceContext>> = {},
): OnboardStateHandlers<TraceContext> {
  return {
    init: () => advanceTo("preflight"),
    preflight: () => advanceTo("gateway"),
    gateway: () => advanceTo("provider_selection"),
    provider_selection: () => advanceTo("inference"),
    inference: () => advanceTo("sandbox"),
    sandbox: () => branchTo("openclaw", { updates: { sandboxName: "my-assistant" } }),
    openclaw: () => advanceTo("policies"),
    agent_setup: () => advanceTo("policies"),
    policies: () => advanceTo("finalizing"),
    finalizing: () => advanceTo("post_verify"),
    post_verify: () => completeOnboardMachine(),
    ...overrides,
  };
}

const CANONICAL_DIRECT_TRANSITIONS = [
  ["init", "preflight", "advance"],
  ["preflight", "gateway", "advance"],
  ["gateway", "provider_selection", "advance"],
  ["provider_selection", "inference", "advance"],
  ["inference", "provider_selection", "retry"],
  ["inference", "sandbox", "advance"],
  ["sandbox", "openclaw", "branch"],
  ["sandbox", "agent_setup", "branch"],
  ["openclaw", "policies", "advance"],
  ["agent_setup", "policies", "advance"],
  ["policies", "finalizing", "advance"],
  ["finalizing", "post_verify", "advance"],
  ["post_verify", "complete", "advance"],
] as const;

// Each tuple skips exactly one live state ahead of the canonical chain.
const ONE_STATE_FORWARD_JUMPS = [
  ["init", "gateway"],
  ["preflight", "provider_selection"],
  ["gateway", "inference"],
  ["provider_selection", "sandbox"],
  ["inference", "openclaw"],
  ["inference", "agent_setup"],
  ["sandbox", "policies"],
  ["openclaw", "finalizing"],
  ["agent_setup", "finalizing"],
  ["policies", "post_verify"],
  ["finalizing", "complete"],
] as const;

describe("onboard machine transition surface (#6225)", () => {
  it.each(
    CANONICAL_DIRECT_TRANSITIONS,
  )("allows %s to reach %s through a %s transition (#6225)", (from, to, kind) => {
    expect(canTransitionOnboardMachineState(from, to)).toBe(true);
    expect(getOnboardMachineTransition(from, to)).toEqual({ from, to, kind });
    expect(assertValidOnboardMachineTransition(from, to).kind).toBe(kind);
  });

  it.each([
    ...ONBOARD_NON_TERMINAL_MACHINE_STATES,
  ])("allows %s to take the shared failure edge (#6225)", (state) => {
    expect(canTransitionOnboardMachineState(state, "failed")).toBe(true);
    expect(getOnboardMachineTransition(state, "failed")).toEqual({
      from: state,
      to: "failed",
      kind: "failure",
    });
  });

  it.each(
    ONE_STATE_FORWARD_JUMPS,
  )("rejects jumping from %s past the next step to %s (#6225)", (from, to) => {
    expect(canTransitionOnboardMachineState(from, to)).toBe(false);
    expect(getOnboardMachineTransition(from, to)).toBeNull();
    expect(() => assertValidOnboardMachineTransition(from, to)).toThrow(
      InvalidOnboardMachineTransitionError,
    );
    expect(() => assertValidOnboardMachineTransition(from, to)).toThrow(
      `Invalid onboarding machine transition: ${from} -> ${to}`,
    );
  });

  it("keeps the inference retry as the only backward edge among live states (#6225)", () => {
    const directTransitions: readonly OnboardMachineTransition[] =
      ONBOARD_MACHINE_DIRECT_TRANSITIONS;
    const stateIndex = (state: OnboardMachineState): number =>
      ONBOARD_MACHINE_STATES.indexOf(state);
    const backwardEdges = directTransitions.filter(
      (transition) =>
        transition.from !== "failed" && stateIndex(transition.to) < stateIndex(transition.from),
    );

    expect(backwardEdges).toEqual([{ from: "inference", to: "provider_selection", kind: "retry" }]);
  });

  it("includes every canonical direct edge in the combined transition table (#6225)", () => {
    expect(ONBOARD_MACHINE_TRANSITIONS).toEqual(
      expect.arrayContaining(
        CANONICAL_DIRECT_TRANSITIONS.map(([from, to, kind]) => ({ from, to, kind })),
      ),
    );
  });
});

describe("fresh onboarding run trace (#6225)", () => {
  it("advances through the openclaw branch to completion in canonical order (#6225)", async () => {
    const { runtime, events } = createTracedRuntime();
    await runtime.start();

    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: fullRunHandlers(),
      updateContext: recordVisited,
    });

    expect(run.context.visited).toEqual([
      "init",
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "sandbox",
      "openclaw",
      "policies",
      "finalizing",
      "post_verify",
    ]);
    expect(run.session).toMatchObject({
      status: "complete",
      resumable: false,
      sandboxName: "my-assistant",
      machine: { state: "complete", revision: 10 },
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

    // Context updates are applied and announced from the source state before
    // the state transition itself is recorded.
    const contextUpdates = events.filter((event) => event.type === "context.updated");
    expect(contextUpdates).toHaveLength(1);
    expect(contextUpdates[0]).toMatchObject({
      state: "sandbox",
      metadata: { fields: ["sandboxName"] },
    });
    expect(events[events.length - 1]).toMatchObject({
      type: "onboard.completed",
      context: { sandboxName: "my-assistant" },
    });
  });

  it("routes the agent branch through agent_setup instead of openclaw (#6225)", async () => {
    const { runtime } = createTracedRuntime();
    const openclawHandler = vi.fn(() => advanceTo("policies"));

    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: fullRunHandlers({
        sandbox: () => branchTo("agent_setup", { updates: { sandboxName: "my-agent" } }),
        openclaw: openclawHandler,
      }),
      updateContext: recordVisited,
    });

    expect(openclawHandler).not.toHaveBeenCalled();
    expect(run.context.visited).toEqual([
      "init",
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "sandbox",
      "agent_setup",
      "policies",
      "finalizing",
      "post_verify",
    ]);
    expect(run.session).toMatchObject({
      status: "complete",
      sandboxName: "my-agent",
      machine: { state: "complete", revision: 10 },
    });
  });

  it("returns from inference to provider selection on retry before advancing to sandbox (#6225)", async () => {
    const { runtime, events } = createTracedRuntime(
      createSession({ machine: machineAt("provider_selection") }),
    );

    // The runner pauses at a stop state without requiring a handler for it —
    // the same handoff mechanism the production flow slices use between the
    // initial, core, and final slices.
    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: {
        provider_selection: () => advanceTo("inference"),
        inference: (context) =>
          context.attempts === 0 ? retryTo("provider_selection") : advanceTo("sandbox"),
      },
      stopStates: ["sandbox"],
      updateContext: recordVisited,
    });

    expect(run.context.visited).toEqual([
      "provider_selection",
      "inference",
      "provider_selection",
      "inference",
    ]);
    expect(run.context.attempts).toBe(2);
    expect(traceOf(events)).toEqual([
      "state.exited:provider_selection",
      "state.entered:inference",
      "state.exited:inference",
      "state.entered:provider_selection",
      "state.exited:provider_selection",
      "state.entered:inference",
      "state.exited:inference",
      "state.entered:sandbox",
    ]);
    expect(run.session).toMatchObject({
      status: "in_progress",
      machine: { state: "sandbox", revision: 4 },
    });
  });
});

describe("resume trace with a completed sandbox step (#6225)", () => {
  it("resumes at openclaw and never re-invokes handlers for completed states (#6225)", async () => {
    const resumedSession = createSession({
      sandboxName: "my-assistant",
      provider: "nvidia",
      model: "model",
      lastCompletedStep: "sandbox",
      machine: machineAt("openclaw", 6),
      steps: {
        preflight: completedStep(),
        gateway: completedStep(),
        provider_selection: completedStep(),
        inference: completedStep(),
        sandbox: completedStep(),
      },
    });
    const { runtime, events } = createTracedRuntime(resumedSession);
    const priorStateHandlers = {
      init: vi.fn(() => advanceTo("preflight")),
      preflight: vi.fn(() => advanceTo("gateway")),
      gateway: vi.fn(() => advanceTo("provider_selection")),
      provider_selection: vi.fn(() => advanceTo("inference")),
      inference: vi.fn(() => advanceTo("sandbox")),
      sandbox: vi.fn(() => branchTo("openclaw")),
    };

    await runtime.start({ resumed: true });
    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: {
        ...priorStateHandlers,
        openclaw: () => advanceTo("policies"),
        policies: () => advanceTo("finalizing"),
        finalizing: () => advanceTo("post_verify"),
        post_verify: () => completeOnboardMachine(),
      },
      updateContext: recordVisited,
    });

    for (const handler of Object.values(priorStateHandlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
    expect(run.context.visited).toEqual(["openclaw", "policies", "finalizing", "post_verify"]);
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
});

describe("sandbox recreate trace (#6225)", () => {
  it("re-runs the sandbox state with repair events around recreate before branching (#6225)", async () => {
    // Machine snapshot back at `sandbox` while the recorded sandbox step is
    // still marked complete: the shape a resumed session has when the
    // recorded sandbox exists but is not ready and must be recreated. The
    // repair-event vocabulary mirrors the sandbox handler's
    // repair-and-recreate sequence (state.repair.started/completed with a
    // recorded-sandbox-cleanup marker).
    const staleSession = createSession({
      sandboxName: "my-assistant",
      lastCompletedStep: "sandbox",
      machine: machineAt("sandbox", 5),
      steps: { sandbox: completedStep() },
    });
    const { runtime, events } = createTracedRuntime(staleSession);
    const repairMetadata = { repair: "recorded-sandbox-cleanup", sandboxName: "my-assistant" };

    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: {
        sandbox: async () => {
          await runtime.emitRepairEvent("state.repair.started", {
            state: "sandbox",
            metadata: repairMetadata,
          });
          await runtime.emitRepairEvent("state.repair.completed", {
            state: "sandbox",
            metadata: repairMetadata,
          });
          return branchTo("openclaw", { updates: { sandboxName: "my-assistant" } });
        },
      },
      stopStates: ["openclaw"],
      updateContext: recordVisited,
    });

    expect(traceOf(events)).toEqual([
      "state.repair.started:sandbox",
      "state.repair.completed:sandbox",
      "context.updated:sandbox",
      "state.exited:sandbox",
      "state.entered:openclaw",
    ]);
    expect(events[0].metadata).toEqual(repairMetadata);
    expect(run.context.visited).toEqual(["sandbox"]);
    expect(run.session).toMatchObject({
      status: "in_progress",
      sandboxName: "my-assistant",
      machine: { state: "openclaw", revision: 6 },
    });
  });
});

describe("mid-flow failure trace (#6225)", () => {
  it("stops at the failing inference step and records the failure envelope (#6225)", async () => {
    const { runtime, events } = createTracedRuntime();
    const sandboxHandler = vi.fn(() => branchTo("openclaw"));

    const run = await runOnboardMachine({
      context: traceContext(),
      runtime,
      handlers: fullRunHandlers({
        inference: () => failOnboardMachine("model probe failed", { step: "inference" }),
        sandbox: sandboxHandler,
      }),
      updateContext: recordVisited,
    });

    expect(sandboxHandler).not.toHaveBeenCalled();
    expect(run.context.visited).toEqual([
      "init",
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
    ]);
    // A failed run stays resumable — `onboard --resume` recovery relies on
    // the failure transition leaving `resumable` untouched.
    expect(run.session).toMatchObject({
      status: "failed",
      resumable: true,
      failure: { step: "inference", message: "model probe failed", recordedAt: NOW },
      machine: { state: "failed", revision: 5 },
    });
    expect(traceOf(events)).toEqual([
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

describe("runtime transition-kind enforcement (#6225)", () => {
  const KIND_MISMATCH_CASES = [
    {
      from: "inference",
      edge: "inference -> provider_selection",
      result: advanceTo("provider_selection"),
      expected: "advance",
      actual: "retry",
    },
    {
      from: "inference",
      edge: "inference -> sandbox",
      result: retryTo("sandbox"),
      expected: "retry",
      actual: "advance",
    },
    {
      from: "sandbox",
      edge: "sandbox -> openclaw",
      result: advanceTo("openclaw"),
      expected: "advance",
      actual: "branch",
    },
    {
      from: "provider_selection",
      edge: "provider_selection -> inference",
      result: branchTo("inference"),
      expected: "branch",
      actual: "advance",
    },
  ] as const;

  it.each(
    KIND_MISMATCH_CASES,
  )("rejects the mistyped result for $edge without touching the session (#6225)", async ({
    from,
    edge,
    result,
    expected,
    actual,
  }) => {
    const { runtime, events } = createTracedRuntime(createSession({ machine: machineAt(from) }));

    await expect(runtime.applyResult(result)).rejects.toThrow(
      `Invalid onboarding machine transition kind: ${edge} expected ${expected}, got ${actual}`,
    );
    await expect(runtime.session()).resolves.toMatchObject({
      machine: { state: from, revision: 0 },
    });
    expect(events).toEqual([]);
  });

  it("accepts an undeclared-kind transition result on any legal edge (#6225)", async () => {
    const { runtime, events } = createTracedRuntime(
      createSession({ machine: machineAt("inference") }),
    );

    await runtime.applyResult(transitionTo("provider_selection"));

    expect(traceOf(events)).toEqual(["state.exited:inference", "state.entered:provider_selection"]);
    await expect(runtime.session()).resolves.toMatchObject({
      machine: { state: "provider_selection", revision: 1 },
    });
  });

  it("validates the transition before applying any context updates (#6225)", async () => {
    const { runtime, events } = createTracedRuntime();

    await expect(
      runtime.applyResult(advanceTo("sandbox", { updates: { sandboxName: "never-created" } })),
    ).rejects.toThrow(InvalidOnboardMachineTransitionError);

    const session = await runtime.session();
    expect(session.sandboxName).toBeNull();
    expect(session.machine).toMatchObject({ state: "init", revision: 0 });
    expect(events).toEqual([]);
  });
});
