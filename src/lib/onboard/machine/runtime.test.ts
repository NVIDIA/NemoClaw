// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  type Session,
  type SessionUpdates,
  sanitizeFailure,
} from "../../state/onboard-session";
import type { StepMutationOptions } from "../../state/onboard-step-mutation";
import type { OnboardMachineEvent } from "./events";
import { advanceTo, branchTo, completeOnboardMachine, failOnboardMachine, retryTo } from "./result";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import { InvalidOnboardMachineTransitionError } from "./transitions";

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function createHarness(initialSession: Session | null = createSession()) {
  let session = initialSession ? cloneSession(initialSession) : null;
  const events: OnboardMachineEvent[] = [];
  const stepOptionCalls: Array<{ method: string; options: StepMutationOptions | undefined }> = [];
  let tick = 0;
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    const current = session ? cloneSession(session) : createSession();
    const next = mutator(current) ?? current;
    session = cloneSession(next);
    return cloneSession(session);
  };
  const deps: OnboardRuntimeDeps = {
    loadSession: () => (session ? cloneSession(session) : null),
    createSession: (overrides) => createSession(overrides),
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
        current.lastStepStarted = stepName;
        current.status = "in_progress";
        return current;
      });
    },
    markStepComplete: (stepName, updates: SessionUpdates = {}, options) => {
      stepOptionCalls.push({ method: "markStepComplete", options });
      return updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "complete";
        current.lastCompletedStep = stepName;
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      });
    },
    markStepCompleteRecordOnly: (stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "complete";
        current.lastCompletedStep = stepName;
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepSkipped: (stepName) =>
      updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "skipped";
        return current;
      }),
    markStepFailed: (stepName, message, options) => {
      stepOptionCalls.push({ method: "markStepFailed", options });
      return updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "failed";
        current.status = "failed";
        current.failure = sanitizeFailure({ step: stepName, message, recordedAt: "now" });
        return current;
      });
    },
    markStepFailedRecordOnly: (stepName, message) =>
      updateSession((current) => {
        const step = current.steps[stepName];
        if (!step) return current;
        step.status = "failed";
        step.error = message ?? null;
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
    emitEvent: (event) => events.push(event),
    now: () => `2026-05-19T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  };
  return {
    runtime: new OnboardRuntime(deps),
    events,
    stepOptionCalls,
    getSession: () => {
      if (!session) throw new Error("Expected runtime session");
      return cloneSession(session);
    },
  };
}

function sessionInState(state: Session["machine"]["state"]): Session {
  const session = createSession();
  session.machine = {
    version: 1,
    state,
    stateEnteredAt: "2026-05-19T00:00:00.000Z",
    revision: 7,
  };
  return session;
}

describe("OnboardRuntime", () => {
  it("starts a session and emits started/resumed lifecycle events", async () => {
    const { runtime, events, getSession } = createHarness(null);

    const started = await runtime.start();
    expect(started.machine.state).toBe("init");
    expect(getSession().machine.state).toBe("init");
    expect(events[0]).toMatchObject({ type: "onboard.started", state: "init" });

    await runtime.start({ resumed: true });
    expect(events[1]).toMatchObject({ type: "onboard.resumed", state: "init" });
  });

  it("forwards step mutation options to step recording dependencies", async () => {
    const { runtime, getSession, stepOptionCalls } = createHarness();
    const recordOnlyOptions = { updateMachine: false };

    await runtime.markStepStarted("preflight", recordOnlyOptions);
    await runtime.markStepComplete("preflight", { sandboxName: "my-assistant" }, recordOnlyOptions);
    await runtime.markStepFailed("gateway", "boom", recordOnlyOptions);

    expect(stepOptionCalls).toEqual([
      { method: "markStepStarted", options: recordOnlyOptions },
      { method: "markStepComplete", options: recordOnlyOptions },
      { method: "markStepFailed", options: recordOnlyOptions },
    ]);
    expect(getSession()).toMatchObject({
      sandboxName: "my-assistant",
      status: "failed",
      steps: {
        preflight: { status: "complete" },
        gateway: { status: "failed" },
      },
    });
  });

  it("validates and persists explicit transitions", async () => {
    const { runtime, events, getSession } = createHarness();

    await runtime.transition("preflight");

    expect(getSession().machine).toEqual({
      version: 1,
      state: "preflight",
      stateEnteredAt: "2026-05-19T00:00:00.000Z",
      revision: 1,
    });
    expect(events.map((event) => event.type)).toEqual(["state.exited", "state.entered"]);
    expect(events[0]).toMatchObject({ state: "init" });
    expect(events[1]).toMatchObject({ state: "preflight" });

    await expect(runtime.transition("sandbox")).rejects.toThrow(
      InvalidOnboardMachineTransitionError,
    );
    expect(getSession().machine.state).toBe("preflight");
  });

  it("applies only safe context updates and emits redacted context events", async () => {
    const { runtime, events, getSession } = createHarness();

    await runtime.updateContext({
      provider: "nvidia-prod",
      endpointUrl: "https://alice:secret@example.com/v1?token=super-secret&keep=yes#token=frag",
      credentialEnv: "NVIDIA_API_KEY",
      apiKey: "super-secret",
    } as Parameters<typeof runtime.updateContext>[0] & { apiKey: string });

    expect(getSession()).toMatchObject({
      provider: "nvidia-prod",
      endpointUrl: "https://example.com/v1?token=%3CREDACTED%3E&keep=yes",
      credentialEnv: "NVIDIA_API_KEY",
    });
    expect("apiKey" in getSession()).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "context.updated", state: "init" });
    expect(events[0].metadata.fields).toEqual(["provider", "endpointUrl", "credentialEnv"]);
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("applies explicit advance results through validated runtime transitions", async () => {
    const { runtime, events, getSession } = createHarness();

    await runtime.applyResult(
      advanceTo("preflight", {
        updates: { sandboxName: "my-assistant" },
        metadata: { source: "handler" },
      }),
    );

    expect(getSession()).toMatchObject({
      sandboxName: "my-assistant",
      machine: { state: "preflight", revision: 1 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "context.updated",
      "state.exited",
      "state.entered",
    ]);
    expect(events[0].metadata).toMatchObject({ fields: ["sandboxName"], source: "handler" });
    expect(events[1]).toMatchObject({ state: "init", metadata: { source: "handler" } });
    expect(events[2]).toMatchObject({ state: "preflight", metadata: { source: "handler" } });
  });

  it("applies explicit retry, branch, completion, and failure results", async () => {
    const retryHarness = createHarness(sessionInState("inference"));
    await retryHarness.runtime.applyResult(retryTo("provider_selection"));
    expect(retryHarness.getSession().machine).toMatchObject({ state: "provider_selection" });

    const branchHarness = createHarness(sessionInState("sandbox"));
    await branchHarness.runtime.applyResult(branchTo("agent_setup"));
    expect(branchHarness.getSession().machine).toMatchObject({ state: "agent_setup" });

    const completeHarness = createHarness(sessionInState("post_verify"));
    await completeHarness.runtime.applyResult(
      completeOnboardMachine({ sandboxName: "done" }, { source: "finalizer" }),
    );
    expect(completeHarness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "done",
      machine: { state: "complete" },
    });
    expect(completeHarness.events.map((event) => event.type)).toEqual([
      "context.updated",
      "state.completed",
      "state.entered",
      "onboard.completed",
    ]);
    expect(completeHarness.events[0].metadata).toMatchObject({
      fields: ["sandboxName"],
      source: "finalizer",
    });
    expect(completeHarness.events[1]).toMatchObject({
      state: "post_verify",
      metadata: { source: "finalizer" },
    });
    expect(completeHarness.events[2]).toMatchObject({
      state: "complete",
      metadata: { source: "finalizer" },
    });
    expect(completeHarness.events[3]).toMatchObject({
      state: "complete",
      metadata: { source: "finalizer" },
    });

    const failedHarness = createHarness(sessionInState("gateway"));
    await failedHarness.runtime.applyResult(failOnboardMachine("boom", { step: "gateway" }));
    expect(failedHarness.getSession()).toMatchObject({
      status: "failed",
      failure: { step: "gateway", message: "boom" },
      machine: { state: "failed" },
    });
  });

  it("rejects invalid explicit transition kinds before mutating context", async () => {
    const { runtime, getSession } = createHarness(sessionInState("inference"));

    await expect(
      runtime.applyResult(advanceTo("provider_selection", { updates: { sandboxName: "mutated" } })),
    ).rejects.toThrow("expected advance, got retry");
    expect(getSession()).toMatchObject({ sandboxName: null, machine: { state: "inference" } });
  });

  it("fails non-terminal sessions with redacted failure events", async () => {
    const { runtime, events, getSession } = createHarness(sessionInState("gateway"));

    await runtime.fail("NVIDIA_API_KEY=super-secret", { step: "gateway" });

    expect(getSession()).toMatchObject({
      status: "failed",
      failure: { step: "gateway", message: "NVIDIA_API_KEY=<REDACTED>" },
      machine: { state: "failed", revision: 8 },
    });
    expect(events.map((event) => event.type)).toEqual(["state.failed", "onboard.failed"]);
    expect(events[0]).toMatchObject({ state: "gateway", step: "gateway" });
    expect(events[1]).toMatchObject({ state: "failed", step: "gateway" });
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("rejects terminal-state failure and invalid completion transitions", async () => {
    const completeHarness = createHarness(sessionInState("complete"));
    await expect(completeHarness.runtime.fail("boom")).rejects.toThrow("complete -> failed");
    expect(completeHarness.getSession().machine.state).toBe("complete");

    const policiesHarness = createHarness(sessionInState("policies"));
    await expect(policiesHarness.runtime.complete()).rejects.toThrow("policies -> complete");
    expect(policiesHarness.getSession().machine.state).toBe("policies");
  });

  it("transitions through finalizing and post_verify before completion", async () => {
    const { runtime, events, getSession } = createHarness(sessionInState("finalizing"));

    await runtime.transition("post_verify");
    await runtime.complete({ sandboxName: "my-assistant" });

    expect(getSession()).toMatchObject({
      status: "complete",
      resumable: false,
      sandboxName: "my-assistant",
      machine: { state: "complete", revision: 9 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "state.exited",
      "state.entered",
      "context.updated",
      "state.completed",
      "state.entered",
      "onboard.completed",
    ]);
    expect(events[0]).toMatchObject({ state: "finalizing" });
    expect(events[1]).toMatchObject({ state: "post_verify" });
  });

  it("emits redacted resume conflict events without mutating durable state", async () => {
    const { runtime, events, getSession } = createHarness(sessionInState("provider_selection"));

    await runtime.emitResumeConflict({
      field: "provider",
      recorded: "nvidia",
      requested: "https://alice:secret@example.com/v1?token=super-secret",
    });

    expect(getSession().machine.state).toBe("provider_selection");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "resume.conflict", state: "provider_selection" });
    expect(events[0].metadata.field).toBe("provider");
    expect(JSON.stringify(events)).not.toContain("super-secret");
    expect(JSON.stringify(events)).not.toContain("alice:secret");
  });

  it("emits skipped and repair events without mutating durable state", async () => {
    const { runtime, events, getSession } = createHarness(sessionInState("provider_selection"));

    await runtime.markSkipped("provider_selection", { reason: "resume" });
    await runtime.emitRepairEvent("state.repair.started", {
      state: "provider_selection",
      metadata: { action: "ollama-systemd" },
    });
    await runtime.emitRepairEvent("state.repair.completed", { state: "provider_selection" });

    expect(getSession().machine.state).toBe("provider_selection");
    expect(events.map((event) => event.type)).toEqual([
      "state.skipped",
      "state.repair.started",
      "state.repair.completed",
    ]);
    expect(events[0].metadata.reason).toBe("resume");
    await expect(runtime.markSkipped("complete")).rejects.toThrow(
      "Terminal onboarding state cannot be skipped",
    );
  });
});
