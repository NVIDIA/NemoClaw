// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
  type SessionUpdates,
  sanitizeFailure,
} from "../../state/onboard-session";
import { advanceTo, branchTo, completeOnboardMachine, failOnboardMachine, retryTo } from "./result";
import {
  EmptyOnboardStateHandlerResultError,
  MissingOnboardStateHandlerError,
  OnboardMachineResultSequenceSourceError,
  OnboardMachineTransitionLimitError,
  type OnboardStateHandlers,
  runOnboardMachine,
} from "./runner";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";

interface RunnerContext {
  attempts: number;
  visited: string[];
}

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createRuntime(initialSession: Session = createSession()) {
  let session = cloneSession(initialSession);
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
    markStepFailed: (_stepName, message) =>
      updateSession((current) => {
        current.status = "failed";
        current.failure = sanitizeFailure({ step: _stepName, message, recordedAt: "now" });
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
    emitEvent: () => undefined,
    now: () => "2026-05-28T00:00:00.000Z",
  };
  return new OnboardRuntime(deps);
}

describe("runOnboardMachine", () => {
  it("runs handlers until completion while applying multiple results, retry, and branch transitions", async () => {
    const runtime = createRuntime();
    const calls: string[] = [];
    const handlers: OnboardStateHandlers<RunnerContext> = {
      init: () => advanceTo("preflight"),
      preflight: () => advanceTo("gateway"),
      gateway: () => advanceTo("provider_selection"),
      provider_selection: (context) => {
        if (context.attempts === 0) return advanceTo("inference");
        return [
          advanceTo("inference", { metadata: { state: "provider_selection" } }),
          advanceTo("sandbox", { metadata: { state: "inference" } }),
        ];
      },
      inference: (context) => {
        calls.push(`inference:${context.attempts}`);
        return retryTo("provider_selection");
      },
      sandbox: () => branchTo("openclaw"),
      openclaw: () => advanceTo("policies"),
      policies: () => advanceTo("finalizing"),
      finalizing: () => advanceTo("post_verify"),
      post_verify: () => completeOnboardMachine({ sandboxName: "my-assistant" }),
    };

    const result = await runOnboardMachine({
      context: { attempts: 0, visited: [] } as RunnerContext,
      runtime,
      handlers,
      updateContext: ({ context, state }) => ({
        attempts: state === "inference" ? context.attempts + 1 : context.attempts,
        visited: [...context.visited, state],
      }),
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
    expect(calls).toEqual(["inference:0"]);
    expect(result.context.visited).toEqual([
      "init",
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "provider_selection",
      "inference",
      "sandbox",
      "openclaw",
      "policies",
      "finalizing",
      "post_verify",
    ]);
  });

  it("rejects handlers that return an empty result list", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: { init: () => [] },
      }),
    ).rejects.toThrow(EmptyOnboardStateHandlerResultError);
  });

  it("requires source-state metadata for multi-result handler sequences", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {
          init: () => [
            advanceTo("preflight"),
            advanceTo("gateway", { metadata: { state: "preflight" } }),
          ],
        },
      }),
    ).rejects.toThrow(OnboardMachineResultSequenceSourceError);
  });

  it("rejects multi-result handler sequences with stale source-state metadata", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {
          init: () => [
            advanceTo("preflight", { metadata: { state: "init" } }),
            advanceTo("gateway", { metadata: { state: "init" } }),
          ],
        },
      }),
    ).rejects.toThrow(OnboardMachineResultSequenceSourceError);
    await expect(runtime.session()).resolves.toMatchObject({ machine: { state: "preflight" } });
  });

  it("propagates invalid transitions after earlier sequence results apply", async () => {
    const runtime = createRuntime();
    const updateContext = vi.fn(({ context, state }) => ({
      ...context,
      visited: [...context.visited, state],
    }));

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {
          init: () => [
            advanceTo("preflight", { metadata: { state: "init" } }),
            advanceTo("sandbox", { metadata: { state: "preflight" } }),
          ],
        },
        updateContext,
      }),
    ).rejects.toThrow("Invalid onboarding machine transition");
    expect(updateContext).toHaveBeenCalledOnce();
    await expect(runtime.session()).resolves.toMatchObject({ machine: { state: "preflight" } });
  });

  it("stops applying handler sequences after terminal results", async () => {
    const runtime = createRuntime();
    const updateContext = vi.fn(({ context, state }) => ({
      ...context,
      visited: [...context.visited, state],
    }));

    const result = await runOnboardMachine({
      context: { attempts: 0, visited: [] } as RunnerContext,
      runtime,
      handlers: {
        init: () => [
          failOnboardMachine("init failed", {
            step: "init",
            metadata: { state: "init" },
          }),
          advanceTo("preflight", { metadata: { state: "failed" } }),
        ],
      },
      updateContext,
    });

    expect(result.session).toMatchObject({
      status: "failed",
      failure: { step: "init", message: "init failed" },
      machine: { state: "failed" },
    });
    expect(result.context.visited).toEqual(["init"]);
    expect(updateContext).toHaveBeenCalledOnce();
  });

  it("counts each handler sequence result toward the transition limit", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {
          init: () => [
            advanceTo("preflight", { metadata: { state: "init" } }),
            advanceTo("gateway", { metadata: { state: "preflight" } }),
          ],
        },
        maxTransitions: 1,
      }),
    ).rejects.toThrow(OnboardMachineTransitionLimitError);
    await expect(runtime.session()).resolves.toMatchObject({ machine: { state: "preflight" } });
  });

  it("stops on failed terminal results", async () => {
    const runtime = createRuntime();
    const policies = vi.fn(() => advanceTo("finalizing"));

    const result = await runOnboardMachine({
      context: { attempts: 0, visited: [] } as RunnerContext,
      runtime,
      handlers: {
        init: () => advanceTo("preflight"),
        preflight: () => failOnboardMachine("preflight failed", { step: "preflight" }),
        policies,
      },
    });

    expect(result.session).toMatchObject({
      status: "failed",
      failure: { step: "preflight", message: "preflight failed" },
      machine: { state: "failed" },
    });
    expect(policies).not.toHaveBeenCalled();
  });

  it("returns immediately for terminal sessions", async () => {
    const startedAt = "2026-05-28T00:00:00.000Z";
    const completeSession = createSession({
      resumable: false,
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "complete",
        stateEnteredAt: startedAt,
        revision: 1,
      },
    });
    completeSession.status = "complete";
    const runtime = createRuntime(completeSession);
    const init = vi.fn(() => advanceTo("preflight"));

    const result = await runOnboardMachine({
      context: { attempts: 0, visited: [] } as RunnerContext,
      runtime,
      handlers: { init },
    });

    expect(result.session).toMatchObject({ status: "complete", machine: { state: "complete" } });
    expect(init).not.toHaveBeenCalled();
  });

  it("propagates runtime transition errors without updating context", async () => {
    const runtime = createRuntime();
    const updateContext = vi.fn(({ context }) => context);

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: { init: () => advanceTo("sandbox") },
        updateContext,
      }),
    ).rejects.toThrow("Invalid onboarding machine transition");
    expect(updateContext).not.toHaveBeenCalled();
  });

  it("throws when a non-terminal state has no handler", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {},
      }),
    ).rejects.toThrow(MissingOnboardStateHandlerError);
  });

  it("throws when retry-capable handlers exceed the transition limit", async () => {
    const runtime = createRuntime();

    await expect(
      runOnboardMachine({
        context: { attempts: 0, visited: [] } as RunnerContext,
        runtime,
        handlers: {
          init: () => advanceTo("preflight"),
          preflight: () => advanceTo("gateway"),
          gateway: () => advanceTo("provider_selection"),
          provider_selection: () => advanceTo("inference"),
          inference: () => retryTo("provider_selection"),
        },
        maxTransitions: 5,
      }),
    ).rejects.toThrow(OnboardMachineTransitionLimitError);
  });

  it("uses the default transition limit for non-finite maxTransitions values", async () => {
    for (const maxTransitions of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const runtime = createRuntime();

      await expect(
        runOnboardMachine({
          context: { attempts: 0, visited: [] } as RunnerContext,
          runtime,
          handlers: {
            init: () => advanceTo("preflight"),
            preflight: () => advanceTo("gateway"),
            gateway: () => advanceTo("provider_selection"),
            provider_selection: () => advanceTo("inference"),
            inference: () => retryTo("provider_selection"),
          },
          maxTransitions,
        }),
      ).rejects.toMatchObject({ maxTransitions: 100 });
    }
  });
});
