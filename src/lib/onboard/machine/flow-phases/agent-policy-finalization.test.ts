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
} from "../../../state/onboard-session";
import type { OnboardFlowContext } from "../flow-context";
import { advanceTo, completeOnboardMachine } from "../result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "../runtime";
import { runOnboardSequenceWithRunner } from "../sequence-runner";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
  createPostVerifyPhase,
} from "./agent-policy-finalization";

function context(): OnboardFlowContext<null, null, null> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-assistant",
    fromDockerfile: null,
    model: "model",
    provider: "provider",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: true,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
  };
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

describe("agent/policy/finalization phases", () => {
  it("creates branch-specific setup phases", async () => {
    const agentPhase = createAgentSetupPhase(async () => ({ result: advanceTo("policies") }));
    const openclawPhase = createOpenclawSetupPhase(async () => ({ result: advanceTo("policies") }));

    expect(agentPhase.state).toBe("agent_setup");
    expect(openclawPhase.state).toBe("openclaw");
    await expect(agentPhase.run(context())).resolves.toMatchObject({
      result: { next: "policies" },
    });
    await expect(openclawPhase.run(context())).resolves.toMatchObject({
      result: { next: "policies" },
    });
  });

  it("maps policies context updates", async () => {
    const phase = createPoliciesPhase(async () => ({
      context: { selectedMessagingChannels: ["slack"] },
      result: advanceTo("finalizing"),
    }));

    const result = await phase.run(context());

    expect(phase.state).toBe("policies");
    expect(result.context.selectedMessagingChannels).toEqual(["slack"]);
    expect(result.result).toMatchObject({ next: "finalizing" });
  });

  it("creates finalization and post-verify phases", async () => {
    const finalizing = createFinalizationPhase(async () => ({ result: advanceTo("post_verify") }));
    const postVerify = createPostVerifyPhase(async () => ({
      result: completeOnboardMachine({ sandboxName: "my-assistant" }),
    }));

    expect(finalizing.state).toBe("finalizing");
    expect(postVerify.state).toBe("post_verify");
    await expect(finalizing.run(context())).resolves.toMatchObject({
      result: { next: "post_verify" },
    });
    await expect(postVerify.run(context())).resolves.toMatchObject({
      result: { type: "complete" },
    });
  });

  it("runs branch-to-completion phases through the strict FSM runner", async () => {
    const initialSession = createSession({
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "openclaw",
        stateEnteredAt: "2026-05-29T00:00:00.000Z",
        revision: 0,
      },
    });

    const result = await runOnboardSequenceWithRunner({
      context: context(),
      runtime: createRuntime(initialSession),
      phases: [
        createOpenclawSetupPhase(async () => ({ result: advanceTo("policies") })),
        createPoliciesPhase(async () => ({
          context: { selectedMessagingChannels: ["slack"] },
          result: advanceTo("finalizing"),
        })),
        createFinalizationPhase(async () => ({ result: advanceTo("post_verify") })),
        createPostVerifyPhase(async () => ({
          result: completeOnboardMachine({ sandboxName: "my-assistant" }),
        })),
      ],
    });

    expect(result.session).toMatchObject({
      status: "complete",
      sandboxName: "my-assistant",
      machine: { state: "complete" },
    });
    expect(result.context.selectedMessagingChannels).toEqual(["slack"]);
  });
});
