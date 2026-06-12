// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import { handleFinalizationState, type FinalizationStateOptions } from "./finalization";

type Agent = { name: string } | null;
type VerifyChain = { port: number };
type VerificationResult = { ok: boolean };

function createDeps(
  overrides: Partial<FinalizationStateOptions<Agent, VerifyChain, VerificationResult>["deps"]> = {},
) {
  const calls = {
    setDefaultSandbox: vi.fn(),
    ensureAgentDashboard: vi.fn(() => 18789),
    postVerify: vi.fn(async () =>
      createSession({
        machine: { version: 1, state: "post_verify", stateEnteredAt: null, revision: 1 },
      }),
    ),
    removeLegacy: vi.fn(),
    cleanupHost: vi.fn(),
    recoverProcesses: vi.fn(),
    autoPairScopeApproval: vi.fn(),
    getChatUiUrl: vi.fn(() => "http://127.0.0.1:18789"),
    buildChain: vi.fn(() => ({ port: 18789 })),
    verify: vi.fn(async () => ({ ok: true })),
    diagnostics: vi.fn(() => ["  ✓ verified"]),
    verifyWebSearch: vi.fn(),
    dashboard: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  return {
    calls,
    deps: {
      ensureAgentDashboardForward: calls.ensureAgentDashboard,
      setDefaultSandbox: calls.setDefaultSandbox,
      recordPostVerifyStarted: calls.postVerify,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      removeLegacyCredentialsFile: calls.removeLegacy,
      cleanupStaleHostFiles: calls.cleanupHost,
      checkAndRecoverSandboxProcesses: calls.recoverProcesses,
      autoPairScopeApproval: calls.autoPairScopeApproval,
      getChatUiUrl: calls.getChatUiUrl,
      buildVerifyChain: calls.buildChain,
      verifyDeployment: calls.verify,
      formatVerificationDiagnostics: calls.diagnostics,
      verifyWebSearchInsideSandbox: calls.verifyWebSearch,
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
    webSearchEnabled: false,
    deps,
  };
}

describe("handleFinalizationState", () => {
  it("completes the session, verifies deployment, and prints the dashboard", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationState(baseOptions(deps));

    // Default is set at finalization (deferred from sandbox creation, #4614), before post-verify starts.
    expect(calls.setDefaultSandbox).toHaveBeenCalledWith("my-assistant");
    expect(calls.setDefaultSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      calls.postVerify.mock.invocationCallOrder[0],
    );
    expect(calls.cleanupHost).toHaveBeenCalledOnce();
    expect(calls.recoverProcesses).toHaveBeenCalledWith("my-assistant", { quiet: true });
    expect(calls.buildChain).toHaveBeenCalledWith("http://127.0.0.1:18789");
    expect(calls.verify).toHaveBeenCalledWith("my-assistant", { port: 18789 });
    expect(calls.log).toHaveBeenCalledWith("  ✓ verified");
    expect(calls.dashboard).toHaveBeenCalledWith("my-assistant", "model", "provider", null, null);
    expect(calls.postVerify).toHaveBeenCalledOnce();
    expect(result.stateResult).toEqual({
      type: "complete",
      updates: {
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
        hermesAuthMethod: null,
        hermesToolGateways: [],
      },
      metadata: { state: "finalizing" },
    });
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });

  it("ensures agent dashboard forwarding before completion for non-OpenClaw agents", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes" };

    await handleFinalizationState({ ...baseOptions(deps), agent });

    expect(calls.ensureAgentDashboard).toHaveBeenCalledWith("my-assistant", agent);
    expect(calls.ensureAgentDashboard.mock.invocationCallOrder[0]).toBeLessThan(
      calls.dashboard.mock.invocationCallOrder[0],
    );
    expect(calls.dashboard).toHaveBeenCalledWith("my-assistant", "model", "provider", null, agent);
  });

  it("does not complete the session when deployment verification fails", async () => {
    const { deps, calls } = createDeps({
      verifyDeployment: vi.fn(async () => {
        throw new Error("verification failed");
      }),
    });

    await expect(handleFinalizationState(baseOptions(deps))).rejects.toThrow("verification failed");

    expect(calls.postVerify).toHaveBeenCalledOnce();
    expect(calls.dashboard).not.toHaveBeenCalled();
    // The sandbox reached finalization (policies confirmed), so it stays the default
    // even when post-policy verification flakes — only a pre-policy cancel rolls back.
    expect(calls.setDefaultSandbox).toHaveBeenCalledWith("my-assistant");
  });

  it("removes legacy credentials only when all staged values migrated", async () => {
    const { deps, calls } = createDeps();

    await handleFinalizationState({
      ...baseOptions(deps),
      stagedLegacyKeys: ["NVIDIA_INFERENCE_API_KEY", "SLACK_BOT_TOKEN"],
      migratedLegacyKeys: new Set(["NVIDIA_INFERENCE_API_KEY", "SLACK_BOT_TOKEN"]),
    });

    expect(calls.removeLegacy).toHaveBeenCalledOnce();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("keeps legacy credentials and warns when migration is incomplete", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationState({
      ...baseOptions(deps),
      stagedLegacyKeys: ["NVIDIA_INFERENCE_API_KEY", "SLACK_BOT_TOKEN"],
      migratedLegacyKeys: new Set(["NVIDIA_INFERENCE_API_KEY"]),
    });

    expect(calls.removeLegacy).not.toHaveBeenCalled();
    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("SLACK_BOT_TOKEN"));
    expect(result.unmigratedLegacyKeys).toEqual(["SLACK_BOT_TOKEN"]);
  });

  it("runs web-search verification only when webSearchEnabled is true", async () => {
    const { deps: depsOff, calls: callsOff } = createDeps();
    await handleFinalizationState(baseOptions(depsOff));
    expect(callsOff.verifyWebSearch).not.toHaveBeenCalled();

    const { deps: depsOn, calls: callsOn } = createDeps();
    const agent = { name: "openclaw" };
    await handleFinalizationState({
      ...baseOptions(depsOn),
      agent,
      webSearchEnabled: true,
    });
    expect(callsOn.verifyWebSearch).toHaveBeenCalledWith("my-assistant", agent);
    // Probe runs after sandbox-process recovery so the post-policy state is live.
    expect(callsOn.verifyWebSearch.mock.invocationCallOrder[0]).toBeGreaterThan(
      callsOn.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(callsOn.verifyWebSearch.mock.invocationCallOrder[0]).toBeLessThan(
      callsOn.verify.mock.invocationCallOrder[0],
    );
  });

  // Scenario A (#4504): the auto-pair scope-approval sweep runs against the
  // freshly-recovered gateway — strictly after process recovery (which can
  // restart the gateway, #3573) and strictly before deployment verification
  // (so the gateway state is settled before we probe it).
  it("runs the auto-pair scope-approval sweep after process recovery and before verify (#4504)", async () => {
    const { deps, calls } = createDeps();

    await handleFinalizationState(baseOptions(deps));

    expect(calls.autoPairScopeApproval).toHaveBeenCalledOnce();
    expect(calls.autoPairScopeApproval).toHaveBeenCalledWith("my-assistant");
    // Ordering: recover → autoPairScopeApproval → verify.
    expect(calls.autoPairScopeApproval.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(calls.autoPairScopeApproval.mock.invocationCallOrder[0]).toBeLessThan(
      calls.verify.mock.invocationCallOrder[0],
    );
  });

  // Scenario B (#4504): the sweep is agent-agnostic — the stuck CLI/webchat
  // scope upgrade can occur regardless of which agent the sandbox runs.
  it("runs the scope-approval sweep regardless of agent type (#4504)", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes" };

    await handleFinalizationState({ ...baseOptions(deps), agent });

    expect(calls.autoPairScopeApproval).toHaveBeenCalledWith("my-assistant");
  });

  // Scenario C (#4504): the dep is documented as best-effort / never-throws and
  // the handler wraps no try/catch around it. Per the contract we assert the
  // implemented behavior: the sweep is invoked and, because it returns cleanly,
  // finalization proceeds to completion (recordSessionComplete still runs). A
  // dep that threw would abort finalization here — the regression this guards.
  it("treats the scope-approval sweep as best-effort and still completes the session (#4504)", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationState(baseOptions(deps));

    expect(calls.autoPairScopeApproval).toHaveBeenCalledOnce();
    // The non-throwing sweep does not abort finalization: it proceeds through
    // verification and the dashboard print to a completed result. (#4472 moved
    // session completion to the imported completeOnboardMachine, so completion
    // is asserted via the downstream dashboard + diagnostics rather than a dep.)
    expect(calls.dashboard).toHaveBeenCalledOnce();
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });
});
