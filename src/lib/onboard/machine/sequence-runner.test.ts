// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  sanitizeFailure,
  type Session,
  type SessionUpdates,
} from "../../state/onboard-session";
import { advanceTo, branchTo, completeOnboardMachine, retryTo } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import {
  buildOnboardSequenceHandlers,
  DuplicateOnboardSequencePhaseError,
  runOnboardSequenceWithRunner,
  type OnboardSequencePhase,
} from "./sequence-runner";

interface SequenceContext {
  attempt: number;
  log: string[];
}

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createRuntime(initialSession: Session = createSession()) {
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
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.status = "failed";
        current.failure = sanitizeFailure({ step: stepName, message, recordedAt: "now" });
        return current;
      }),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
        return current;
      }),
    filterSafeUpdates,
    emitEvent: () => undefined,
    now: () => "2026-05-29T00:00:00.000Z",
  };
  return new OnboardRuntime(deps);
}

function phase(
  state: OnboardSequencePhase<SequenceContext>["state"],
  run: OnboardSequencePhase<SequenceContext>["run"],
): OnboardSequencePhase<SequenceContext> {
  return { state, run };
}

describe("onboard sequence runner", () => {
  it("runs sequence phases through the strict FSM runner", async () => {
    const phases: OnboardSequencePhase<SequenceContext>[] = [
      phase("init", (context) => ({
        context: { ...context, log: [...context.log, "init"] },
        result: advanceTo("preflight"),
      })),
      phase("preflight", (context) => ({
        context: { ...context, log: [...context.log, "preflight"] },
        result: advanceTo("gateway"),
      })),
      phase("gateway", (context) => ({
        context: { ...context, log: [...context.log, "gateway"] },
        result: advanceTo("provider_selection"),
      })),
      phase("provider_selection", (context) => {
        if (context.attempt === 0) {
          return {
            context: { attempt: 1, log: [...context.log, "provider:first"] },
            result: [advanceTo("inference"), retryTo("provider_selection")],
          };
        }
        return {
          context: { ...context, log: [...context.log, "provider:second"] },
          result: [advanceTo("inference"), advanceTo("sandbox")],
        };
      }),
      phase("sandbox", (context) => ({
        context: { ...context, log: [...context.log, "sandbox"] },
        result: branchTo("openclaw"),
      })),
      phase("openclaw", (context) => ({
        context: { ...context, log: [...context.log, "openclaw"] },
        result: advanceTo("policies"),
      })),
      phase("policies", (context) => ({
        context: { ...context, log: [...context.log, "policies"] },
        result: advanceTo("finalizing"),
      })),
      phase("finalizing", (context) => ({
        context: { ...context, log: [...context.log, "finalizing"] },
        result: advanceTo("post_verify"),
      })),
      phase("post_verify", (context) => ({
        context: { ...context, log: [...context.log, "post_verify"] },
        result: completeOnboardMachine({ sandboxName: "my-assistant" }),
      })),
    ];

    const result = await runOnboardSequenceWithRunner({
      context: { attempt: 0, log: [] },
      runtime: createRuntime(),
      phases,
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
    expect(result.context).toEqual({
      attempt: 1,
      log: [
        "init",
        "preflight",
        "gateway",
        "provider:first",
        "provider:second",
        "sandbox",
        "openclaw",
        "policies",
        "finalizing",
        "post_verify",
      ],
    });
  });

  it("rejects duplicate phases before running", () => {
    expect(() =>
      buildOnboardSequenceHandlers(
        [
          phase("preflight", (context) => ({ context, result: advanceTo("gateway") })),
          phase("preflight", (context) => ({ context, result: advanceTo("gateway") })),
        ],
        () => undefined,
      ),
    ).toThrow(DuplicateOnboardSequencePhaseError);
  });
});
