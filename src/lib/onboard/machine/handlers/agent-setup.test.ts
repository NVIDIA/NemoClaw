// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handleAgentSetupState, type AgentSetupStateOptions } from "./agent-setup";

type Agent = { name: string; displayName: string };

function createDeps(overrides: Partial<AgentSetupStateOptions<Agent>["deps"]> = {}) {
  let session = createSession();
  const calls = {
    handleAgentSetup: vi.fn(async () => undefined),
    context: vi.fn(() => ({ ctx: true })),
    ensureDashboard: vi.fn(() => 18789),
    persistDashboardPort: vi.fn(),
    skipped: vi.fn(async (stepName: string) => {
      session.steps[stepName].status = "skipped";
      return session;
    }),
    openclawReady: vi.fn(() => false),
    skippedMessage: vi.fn(),
    recordSkip: vi.fn(async () => createSession()),
    startStep: vi.fn(async () => undefined),
    setupOpenclaw: vi.fn(async () => undefined),
    configureOpenclaw: vi.fn(async () => undefined),
    complete: vi.fn(async (stepName: string, updates: SessionUpdates = {}) => {
      session.steps[stepName].status = "complete";
      Object.assign(session, updates);
      return session;
    }),
  };
  return {
    calls,
    deps: {
      handleAgentSetup: calls.handleAgentSetup,
      agentSetupContext: calls.context,
      ensureAgentDashboardForward: calls.ensureDashboard,
      persistDashboardPort: calls.persistDashboardPort,
      recordStepSkipped: calls.skipped,
      isOpenclawReady: calls.openclawReady,
      skippedStepMessage: calls.skippedMessage,
      recordStateSkipped: calls.recordSkip,
      startRecordedStep: calls.startStep,
      setupOpenclaw: calls.setupOpenclaw,
      configureOpenclawSandbox: calls.configureOpenclaw,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      ...overrides,
    },
  };
}

function baseOptions(
  deps: AgentSetupStateOptions<Agent>["deps"],
  agent: Agent | null = null,
): AgentSetupStateOptions<Agent> {
  return {
    agent,
    sandboxName: "my-assistant",
    model: "model",
    provider: "provider",
    webSearchConfig: null,
    resume: false,
    session: createSession(),
    hermesAuthMethod: null,
    hermesToolGateways: [],
    deps,
  };
}

describe("handleAgentSetupState", () => {
  it("delegates non-OpenClaw agent setup and skips openclaw", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes", displayName: "Hermes" };
    const session = createSession();

    const result = await handleAgentSetupState({
      ...baseOptions(deps, agent),
      session,
      resume: true,
    });

    expect(calls.handleAgentSetup).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      agent,
      true,
      session,
      { ctx: true },
    );
    expect(calls.ensureDashboard).toHaveBeenCalledWith("my-assistant", agent);
    expect(calls.skipped).toHaveBeenCalledWith("openclaw");
    expect(calls.setupOpenclaw).not.toHaveBeenCalled();
    expect(result.session?.steps.openclaw.status).toBe("skipped");
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "policies",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "agent_setup" },
    });
  });

  it("persists the bumped dashboard port returned by the forward (#8214)", async () => {
    const { deps, calls } = createDeps({});
    calls.ensureDashboard.mockReturnValue(18791);
    const agent = { name: "hermes", displayName: "Hermes" };

    await handleAgentSetupState({ ...baseOptions(deps, agent), resume: true });

    expect(calls.ensureDashboard).toHaveBeenCalledWith("my-assistant", agent);
    expect(calls.persistDashboardPort).toHaveBeenCalledWith("my-assistant", 18791);
  });

  it("does not persist a dashboard port when the agent manages no dashboard (#8214)", async () => {
    const { deps, calls } = createDeps({});
    calls.ensureDashboard.mockReturnValue(0);
    const agent = { name: "hermes", displayName: "Hermes" };

    await handleAgentSetupState({ ...baseOptions(deps, agent), resume: true });

    expect(calls.persistDashboardPort).not.toHaveBeenCalled();
  });

  it("skips OpenClaw setup on resume when OpenClaw is ready", async () => {
    const { deps, calls } = createDeps({ isOpenclawReady: vi.fn(() => true) });

    const result = await handleAgentSetupState({ ...baseOptions(deps), resume: true });

    expect(calls.skippedMessage).toHaveBeenCalledWith("openclaw", "my-assistant");
    expect(calls.recordSkip).toHaveBeenCalledWith("openclaw", {
      reason: "resume",
      sandboxName: "my-assistant",
    });
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.setupOpenclaw).not.toHaveBeenCalled();
    expect(calls.configureOpenclaw).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      undefined,
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "openclaw",
      expect.objectContaining({
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
      }),
    );
    expect(calls.skipped).toHaveBeenCalledWith("agent_setup");
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "policies",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "openclaw" },
    });
    expect(result.session).toMatchObject({
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      steps: { openclaw: { status: "complete" }, agent_setup: { status: "skipped" } },
    });
  });

  it("delegates shared OpenClaw configuration before ready-resume completion", async () => {
    const { deps, calls } = createDeps({ isOpenclawReady: vi.fn(() => true) });
    const revalidateSandboxIdentity = vi.fn();

    await handleAgentSetupState({
      ...baseOptions(deps),
      resume: true,
      webSearchConfig: { fetchEnabled: false },
      revalidateSandboxIdentity,
    });

    expect(calls.configureOpenclaw).toHaveBeenCalledExactlyOnceWith(
      "my-assistant",
      "model",
      "provider",
      { fetchEnabled: false },
      revalidateSandboxIdentity,
    );
    expect(calls.configureOpenclaw.mock.invocationCallOrder[0]).toBeLessThan(
      calls.recordSkip.mock.invocationCallOrder[0],
    );
    expect(calls.configureOpenclaw.mock.invocationCallOrder[0]).toBeLessThan(
      calls.complete.mock.invocationCallOrder[0],
    );
  });

  it("does not complete ready resume when config-sync authority revalidation fails", async () => {
    const configExec = vi.fn();
    const configureOpenclawSandbox = vi.fn(
      (
        sandboxName: string,
        _model: string,
        _provider: string,
        _webSearchConfig: { fetchEnabled?: boolean } | null,
        revalidate?: (operation: string) => void,
      ): Promise<void> => {
        revalidate?.(`synchronize OpenClaw config in sandbox '${sandboxName}'`);
        configExec();
        return Promise.resolve();
      },
    );
    const { deps, calls } = createDeps({
      isOpenclawReady: vi.fn(() => true),
      configureOpenclawSandbox,
    });
    const revalidationSteps = new Map([
      [
        "synchronize OpenClaw config in sandbox 'my-assistant'",
        () => {
          throw new Error("sandbox identity changed");
        },
      ],
    ]);
    const revalidateSandboxIdentity = vi.fn((operation: string) =>
      revalidationSteps.get(operation)?.(),
    );

    await expect(
      handleAgentSetupState({
        ...baseOptions(deps),
        resume: true,
        revalidateSandboxIdentity,
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(configExec).not.toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("runs OpenClaw setup and skips agent_setup for the default agent", async () => {
    const { deps, calls } = createDeps();

    const result = await handleAgentSetupState({
      ...baseOptions(deps),
      hermesAuthMethod: "oauth",
      hermesToolGateways: ["github"],
    });

    expect(calls.startStep).toHaveBeenCalledWith("openclaw", {
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
    });
    expect(calls.setupOpenclaw).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      undefined,
    );
    expect(calls.configureOpenclaw).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "openclaw",
      expect.objectContaining({
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
        hermesAuthMethod: "oauth",
        hermesToolGateways: ["github"],
      }),
    );
    expect(calls.skipped).toHaveBeenCalledWith("agent_setup");
    expect(result.stateResult).toMatchObject({ next: "policies", transitionKind: "advance" });
    expect(result.session).toMatchObject({
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      hermesAuthMethod: "oauth",
      hermesToolGateways: ["github"],
      steps: { openclaw: { status: "complete" }, agent_setup: { status: "skipped" } },
    });
  });

  it("returns a session when the input session is null", async () => {
    const { deps } = createDeps();

    const result = await handleAgentSetupState({ ...baseOptions(deps), session: null });

    expect(result.session).toMatchObject({
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      steps: { openclaw: { status: "complete" }, agent_setup: { status: "skipped" } },
    });
  });
});
