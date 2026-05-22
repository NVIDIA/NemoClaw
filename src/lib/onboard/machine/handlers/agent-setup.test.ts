// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handleAgentSetupState, type AgentSetupStateOptions } from "./agent-setup";

type Agent = { name: string; displayName: string };

function createDeps(overrides: Partial<AgentSetupStateOptions<Agent>["deps"]> = {}) {
  const calls = {
    handleAgentSetup: vi.fn(async () => undefined),
    context: vi.fn(() => ({ ctx: true })),
    ensureDashboard: vi.fn(() => 18789),
    skipped: vi.fn(async () => createSession()),
    openclawReady: vi.fn(() => false),
    skippedMessage: vi.fn(),
    startStep: vi.fn(async () => undefined),
    setupOpenclaw: vi.fn(async () => undefined),
    syncConfig: vi.fn(),
    complete: vi.fn(async () => createSession()),
  };
  return {
    calls,
    deps: {
      handleAgentSetup: calls.handleAgentSetup,
      agentSetupContext: calls.context,
      ensureAgentDashboardForward: calls.ensureDashboard,
      recordStepSkipped: calls.skipped,
      isOpenclawReady: calls.openclawReady,
      skippedStepMessage: calls.skippedMessage,
      startRecordedStep: calls.startStep,
      setupOpenclaw: calls.setupOpenclaw,
      syncNemoClawConfigInSandbox: calls.syncConfig,
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

    await handleAgentSetupState({ ...baseOptions(deps, agent), session, resume: true });

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
  });

  it("skips OpenClaw setup on resume when OpenClaw is ready", async () => {
    const { deps, calls } = createDeps({ isOpenclawReady: vi.fn(() => true) });

    await handleAgentSetupState({ ...baseOptions(deps), resume: true });

    expect(calls.skippedMessage).toHaveBeenCalledWith("openclaw", "my-assistant");
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.setupOpenclaw).not.toHaveBeenCalled();
    expect(calls.syncConfig).toHaveBeenCalledWith("my-assistant", "provider", "model");
    expect(calls.complete).toHaveBeenCalledWith(
      "openclaw",
      expect.objectContaining({ sandboxName: "my-assistant", provider: "provider", model: "model" }),
    );
    expect(calls.skipped).toHaveBeenCalledWith("agent_setup");
  });

  it("runs OpenClaw setup and skips agent_setup for the default agent", async () => {
    const { deps, calls } = createDeps();

    await handleAgentSetupState({
      ...baseOptions(deps),
      hermesAuthMethod: "oauth",
      hermesToolGateways: ["github"],
    });

    expect(calls.startStep).toHaveBeenCalledWith("openclaw", {
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
    });
    expect(calls.setupOpenclaw).toHaveBeenCalledWith("my-assistant", "model", "provider");
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
  });
});
