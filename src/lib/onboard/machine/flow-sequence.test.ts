// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  sanitizeFailure,
  type Session,
  type SessionUpdates,
} from "../../state/onboard-session";
import type { OnboardFlowContext, OnboardFlowPhaseResult } from "./flow-context";
import { onboardFlowPhaseResult } from "./flow-context";
import { buildOnboardFlowPhaseSequence } from "./flow-sequence";
import { advanceTo, branchTo, completeOnboardMachine } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import { runOnboardSequenceWithRunner } from "./sequence-runner";

type Context = OnboardFlowContext<null, { type: string }, { mode: string }>;

function context(): Context {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: null,
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: { mode: "0" },
    gpuPassthrough: false,
  };
}

function result(
  ctx: Context,
  next: ReturnType<typeof advanceTo>["next"],
): OnboardFlowPhaseResult<Context> {
  return onboardFlowPhaseResult(ctx, advanceTo(next));
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
    markStepCompleteRecordOnly: (_stepName, updates: SessionUpdates = {}) =>
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
    now: () => "2026-05-29T00:00:00.000Z",
  };
  return new OnboardRuntime(deps);
}

describe("onboard flow phase sequence", () => {
  it("assembles phases in machine order", () => {
    const phases = buildOnboardFlowPhaseSequence<Context>({
      preflight: async (ctx) =>
        result({ ...ctx, gpu: { type: "nvidia" }, gpuPassthrough: true }, "gateway"),
      gateway: async (ctx) => result(ctx, "provider_selection"),
      providerInference: async (ctx) =>
        result({ ...ctx, provider: "nvidia", model: "model" }, "sandbox"),
      sandbox: async (ctx) =>
        onboardFlowPhaseResult({ ...ctx, sandboxName: "my-assistant" }, branchTo("openclaw")),
      openclaw: async (ctx) => result(ctx, "policies"),
      agentSetup: async (ctx) => result(ctx, "policies"),
      policies: async (ctx) => result(ctx, "finalizing"),
      finalization: async (ctx) => result(ctx, "post_verify"),
      postVerify: async (ctx) => onboardFlowPhaseResult(ctx, completeOnboardMachine()),
    });

    expect(phases.map((phase) => phase.state)).toEqual([
      "preflight",
      "gateway",
      "provider_selection",
      "sandbox",
      "openclaw",
      "agent_setup",
      "policies",
      "finalizing",
      "post_verify",
    ]);
  });

  it("delegates phase execution to supplied handlers", async () => {
    const phases = buildOnboardFlowPhaseSequence<Context>({
      preflight: async (ctx) =>
        result({ ...ctx, gpu: { type: "nvidia" }, gpuPassthrough: true }, "gateway"),
      gateway: async (ctx) => result(ctx, "provider_selection"),
      providerInference: async (ctx) => result(ctx, "sandbox"),
      sandbox: async (ctx) => onboardFlowPhaseResult(ctx, branchTo("openclaw")),
      openclaw: async (ctx) => result(ctx, "policies"),
      agentSetup: async (ctx) => result(ctx, "policies"),
      policies: async (ctx) => result(ctx, "finalizing"),
      finalization: async (ctx) => result(ctx, "post_verify"),
      postVerify: async (ctx) => onboardFlowPhaseResult(ctx, completeOnboardMachine()),
    });

    const preflight = await phases[0].run(context());

    expect(preflight.context.gpu).toEqual({ type: "nvidia" });
    expect(preflight.result).toMatchObject({ next: "gateway" });
  });

  it("runs ordered provider results through runtime transition validation", async () => {
    const initialSession = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "preflight",
        stateEnteredAt: "2026-05-29T00:00:00.000Z",
        revision: 0,
      },
    });
    const phases = buildOnboardFlowPhaseSequence<Context>({
      preflight: async (ctx) =>
        result({ ...ctx, gpu: { type: "nvidia" }, gpuPassthrough: true }, "gateway"),
      gateway: async (ctx) => result(ctx, "provider_selection"),
      providerInference: async (ctx) =>
        onboardFlowPhaseResult({ ...ctx, provider: "nvidia", model: "model" }, [
          advanceTo("inference", { metadata: { state: "provider_selection" } }),
          advanceTo("sandbox", { metadata: { state: "inference" } }),
        ]),
      sandbox: async (ctx) =>
        onboardFlowPhaseResult({ ...ctx, sandboxName: "my-assistant" }, branchTo("openclaw")),
      openclaw: async (ctx) => result(ctx, "policies"),
      agentSetup: async (ctx) => result(ctx, "policies"),
      policies: async (ctx) => result(ctx, "finalizing"),
      finalization: async (ctx) => result(ctx, "post_verify"),
      postVerify: async (ctx) =>
        onboardFlowPhaseResult(ctx, completeOnboardMachine({ sandboxName: "my-assistant" })),
    });

    const run = await runOnboardSequenceWithRunner({
      context: context(),
      runtime: createRuntime(initialSession),
      phases,
    });

    expect(run.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
    expect(run.context).toMatchObject({
      provider: "nvidia",
      model: "model",
      sandboxName: "my-assistant",
    });
  });
});
