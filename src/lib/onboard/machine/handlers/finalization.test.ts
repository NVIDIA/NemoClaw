// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import { handleFinalizationState, type FinalizationStateOptions } from "./finalization";

type Agent = { name: string } | null;
type VerifyChain = { port: number };
type VerificationResult = { ok: boolean };

function createDeps(overrides: Partial<FinalizationStateOptions<Agent, VerifyChain, VerificationResult>["deps"]> = {}) {
  const calls = {
    ensureAgentDashboard: vi.fn(() => 18789),
    complete: vi.fn(async () => createSession({ status: "complete" })),
    removeLegacy: vi.fn(),
    cleanupHost: vi.fn(),
    recoverProcesses: vi.fn(),
    getChatUiUrl: vi.fn(() => "http://127.0.0.1:18789"),
    buildChain: vi.fn(() => ({ port: 18789 })),
    verify: vi.fn(async () => ({ ok: true })),
    diagnostics: vi.fn(() => ["  ✓ verified"]),
    dashboard: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  return {
    calls,
    deps: {
      ensureAgentDashboardForward: calls.ensureAgentDashboard,
      recordSessionComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      removeLegacyCredentialsFile: calls.removeLegacy,
      cleanupStaleHostFiles: calls.cleanupHost,
      checkAndRecoverSandboxProcesses: calls.recoverProcesses,
      getChatUiUrl: calls.getChatUiUrl,
      buildVerifyChain: calls.buildChain,
      verifyDeployment: calls.verify,
      formatVerificationDiagnostics: calls.diagnostics,
      printDashboard: calls.dashboard,
      error: calls.error,
      log: calls.log,
      ...overrides,
    },
  };
}

function baseOptions(
  deps: FinalizationStateOptions<Agent, VerifyChain, VerificationResult>["deps"],
): FinalizationStateOptions<Agent, VerifyChain, VerificationResult> {
  return {
    sandboxName: "my-assistant",
    model: "model",
    provider: "provider",
    nimContainer: null,
    agent: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    stagedLegacyKeys: [],
    migratedLegacyKeys: new Set(),
    deps,
  };
}

describe("handleFinalizationState", () => {
  it("completes the session, verifies deployment, and prints the dashboard", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationState(baseOptions(deps));

    expect(calls.complete).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      hermesAuthMethod: null,
      hermesToolGateways: [],
    });
    expect(calls.cleanupHost).toHaveBeenCalledOnce();
    expect(calls.recoverProcesses).toHaveBeenCalledWith("my-assistant", { quiet: true });
    expect(calls.buildChain).toHaveBeenCalledWith("http://127.0.0.1:18789");
    expect(calls.verify).toHaveBeenCalledWith("my-assistant", { port: 18789 });
    expect(calls.log).toHaveBeenCalledWith("  ✓ verified");
    expect(calls.dashboard).toHaveBeenCalledWith("my-assistant", "model", "provider", null, null);
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });

  it("ensures agent dashboard forwarding before completion for non-OpenClaw agents", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes" };

    await handleFinalizationState({ ...baseOptions(deps), agent });

    expect(calls.ensureAgentDashboard).toHaveBeenCalledWith("my-assistant", agent);
    expect(calls.dashboard).toHaveBeenCalledWith("my-assistant", "model", "provider", null, agent);
  });

  it("removes legacy credentials only when all staged values migrated", async () => {
    const { deps, calls } = createDeps();

    await handleFinalizationState({
      ...baseOptions(deps),
      stagedLegacyKeys: ["NVIDIA_API_KEY", "SLACK_BOT_TOKEN"],
      migratedLegacyKeys: new Set(["NVIDIA_API_KEY", "SLACK_BOT_TOKEN"]),
    });

    expect(calls.removeLegacy).toHaveBeenCalledOnce();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("keeps legacy credentials and warns when migration is incomplete", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationState({
      ...baseOptions(deps),
      stagedLegacyKeys: ["NVIDIA_API_KEY", "SLACK_BOT_TOKEN"],
      migratedLegacyKeys: new Set(["NVIDIA_API_KEY"]),
    });

    expect(calls.removeLegacy).not.toHaveBeenCalled();
    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("SLACK_BOT_TOKEN"));
    expect(result.unmigratedLegacyKeys).toEqual(["SLACK_BOT_TOKEN"]);
  });
});
