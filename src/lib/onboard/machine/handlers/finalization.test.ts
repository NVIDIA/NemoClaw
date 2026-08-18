// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SessionUpdates } from "../../../state/onboard-session";
import {
  type FinalizationStateOptions,
  handleFinalizationState as handleFinalizationPhase,
  handlePostVerifyState,
} from "./finalization";

type Agent = {
  name: string;
  displayName?: string;
  forwardPort?: number | null;
  forward_ports?: number[] | null;
  runtime?: {
    kind?: string;
    interactive_command?: string;
    headless_command?: string;
  };
} | null;
type VerifyChain = { port: number };
type VerificationResult = { ok: boolean };

function createDeps(
  overrides: Partial<FinalizationStateOptions<Agent, VerifyChain, VerificationResult>["deps"]> = {},
) {
  const calls = {
    setDefaultSandbox: vi.fn(),
    ensureAgentDashboard: vi.fn(() => 18789),
    persistDashboardPort: vi.fn(),
    removeLegacy: vi.fn(),
    cleanupHost: vi.fn(),
    recoverProcesses: vi.fn(),
    warmupScopeUpgrade: vi.fn(),
    autoPairScopeApproval: vi.fn(),
    readRegistryAgent: vi.fn(() => "openclaw"),
    settlePortablePairing: vi.fn(async () => ({ kind: "settled" as const })),
    portablePairingIncompleteMessage: vi.fn(
      () => "Portable onboarding is incomplete; resume onboarding.",
    ),
    getChatUiUrl: vi.fn(() => "http://127.0.0.1:18789"),
    buildChain: vi.fn(() => ({ port: 18789 })),
    verify: vi.fn(async () => ({ ok: true })),
    diagnostics: vi.fn(() => ["  ✓ verified"]),
    verifyWebSearch: vi.fn(() => true),
    dashboard: vi.fn(),
    isHealthy: vi.fn(() => true),
    reportReadiness: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  return {
    calls,
    deps: {
      ensureAgentDashboardForward: calls.ensureAgentDashboard,
      persistDashboardPort: calls.persistDashboardPort,
      setDefaultSandbox: calls.setDefaultSandbox,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      removeLegacyCredentialsFile: calls.removeLegacy,
      cleanupStaleHostFiles: calls.cleanupHost,
      checkAndRecoverSandboxProcesses: calls.recoverProcesses,
      warmupScopeUpgrade: calls.warmupScopeUpgrade,
      autoPairScopeApproval: calls.autoPairScopeApproval,
      readRegistryAgent: calls.readRegistryAgent,
      settlePortablePairing: calls.settlePortablePairing,
      portablePairingIncompleteMessage: calls.portablePairingIncompleteMessage,
      getChatUiUrl: calls.getChatUiUrl,
      buildVerifyChain: calls.buildChain,
      verifyDeployment: calls.verify,
      formatVerificationDiagnostics: calls.diagnostics,
      verifyWebSearchInsideSandbox: calls.verifyWebSearch,
      printDashboard: calls.dashboard,
      isDeploymentHealthy: calls.isHealthy,
      reportDeploymentReadiness: calls.reportReadiness,
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
    webSearchProvider: null,
    deps,
  };
}

async function runFinalizationHandlers(
  options: FinalizationStateOptions<Agent, VerifyChain, VerificationResult>,
) {
  const finalizationResult = await handleFinalizationPhase(options);
  const postVerifyResult = await handlePostVerifyState(options);
  return {
    ...postVerifyResult,
    unmigratedLegacyKeys: finalizationResult.unmigratedLegacyKeys,
  };
}

describe("finalization handlers", () => {
  it("advances to post verification before deployment verification runs", async () => {
    const { deps, calls } = createDeps();

    const result = await handleFinalizationPhase(baseOptions(deps));

    expect(result.stateResult).toEqual({
      type: "transition",
      next: "post_verify",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "finalizing" },
    });
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
  });

  it("completes the session, verifies deployment, and prints the dashboard", async () => {
    const { deps, calls } = createDeps();

    const result = await runFinalizationHandlers(baseOptions(deps));

    // Default is set at finalization (deferred from sandbox creation, #4614), before verification.
    expect(calls.setDefaultSandbox).toHaveBeenCalledWith("my-assistant");
    expect(calls.setDefaultSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      calls.verify.mock.invocationCallOrder[0],
    );
    expect(calls.cleanupHost).toHaveBeenCalledOnce();
    expect(calls.recoverProcesses).toHaveBeenCalledWith("my-assistant", { quiet: true });
    // The sandbox name lets the chain resolve this sandbox's own agent API
    // port rather than the agent manifest default (#9290).
    expect(calls.buildChain).toHaveBeenCalledWith("http://127.0.0.1:18789", "my-assistant");
    expect(calls.verify).toHaveBeenCalledWith("my-assistant", { port: 18789 });
    expect(calls.log).toHaveBeenCalledWith("  ✓ verified");
    expect(calls.dashboard).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      null,
      true,
    );
    expect(result.stateResult).toEqual({
      type: "complete",
      updates: {
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
        hermesAuthMethod: null,
        hermesToolGateways: [],
      },
      metadata: { state: "post_verify" },
    });
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });

  it("uses strict Portable settlement instead of ordinary warm-up and approval (#9207)", async () => {
    const { deps, calls } = createDeps();
    const options = {
      ...baseOptions(deps),
      agent: { name: "openclaw" },
      portableProfileSelected: true,
    };

    const result = await runFinalizationHandlers(options);

    expect(result.stateResult.type).toBe("complete");
    expect(calls.warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(calls.autoPairScopeApproval).not.toHaveBeenCalled();
    expect(calls.settlePortablePairing).toHaveBeenCalledExactlyOnceWith("my-assistant", {
      portableRequired: true,
    });
  });

  it("fails selected Portable OpenClaw closed before ordinary writers when registry identity is invalid (#9207)", async () => {
    const { deps, calls } = createDeps({
      settlePortablePairing: vi.fn(async () => ({
        kind: "incomplete" as const,
        reason: "portable-runtime-identity-invalid" as const,
      })),
    });
    const options = {
      ...baseOptions(deps),
      agent: { name: "openclaw" },
      portableProfileSelected: true,
    };

    await handleFinalizationPhase(options);
    const result = await handlePostVerifyState(options);

    expect(result).toMatchObject({
      deploymentHealthy: false,
      stateResult: {
        type: "pause",
        metadata: { state: "post_verify", reason: "portable_pairing_incomplete" },
      },
    });
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
    expect(calls.warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(calls.autoPairScopeApproval).not.toHaveBeenCalled();
    expect(calls.reportReadiness).toHaveBeenCalledWith(false);
    expect(calls.error).toHaveBeenCalledWith(
      "  Portable onboarding is incomplete; resume onboarding.",
    );
  });

  it("keeps Portable Hermes on its prior finalization path (#9207)", async () => {
    const { deps, calls } = createDeps({ readRegistryAgent: vi.fn(() => "hermes") });
    const options = {
      ...baseOptions(deps),
      agent: { name: "hermes" },
      portableProfileSelected: true,
    };

    const result = await runFinalizationHandlers(options);

    expect(result.stateResult.type).toBe("complete");
    expect(calls.warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(calls.autoPairScopeApproval).toHaveBeenCalledOnce();
    expect(calls.settlePortablePairing).not.toHaveBeenCalled();
  });

  it("rejects a Portable non-OpenClaw session and registry mismatch before pairing writes (#9207)", async () => {
    const { deps, calls } = createDeps({ readRegistryAgent: vi.fn(() => "openclaw") });
    const options = {
      ...baseOptions(deps),
      agent: { name: "hermes" },
      portableProfileSelected: true,
    };

    await handleFinalizationPhase(options);
    const result = await handlePostVerifyState(options);

    expect(result).toMatchObject({
      deploymentHealthy: false,
      stateResult: {
        type: "pause",
        metadata: { state: "post_verify", reason: "portable_pairing_incomplete" },
      },
    });
    expect(calls.warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(calls.autoPairScopeApproval).not.toHaveBeenCalled();
    expect(calls.settlePortablePairing).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it("prints a not-ready dashboard and returns a resumable failure when verification is unhealthy", async () => {
    const { deps, calls } = createDeps({ isDeploymentHealthy: vi.fn(() => false) });

    const result = await runFinalizationHandlers(baseOptions(deps));

    expect(calls.dashboard).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      null,
      false,
    );
    expect(calls.reportReadiness).toHaveBeenCalledWith(false);
    expect(result.deploymentHealthy).toBe(false);
    expect(result.stateResult).toEqual({
      type: "pause",
      updates: {
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
        hermesAuthMethod: null,
        hermesToolGateways: [],
      },
      metadata: { state: "post_verify", reason: "deployment_not_ready" },
    });
  });

  it("restores the default OpenClaw dashboard forward after process recovery", async () => {
    let forwardLive = true;
    const recoverProcesses = vi.fn(() => {
      forwardLive = false;
    });
    const ensureDashboard = vi.fn(() => {
      forwardLive = true;
      return 18789;
    });
    const verify = vi.fn(async () => ({ ok: forwardLive }));
    const { deps } = createDeps({
      checkAndRecoverSandboxProcesses: recoverProcesses,
      ensureAgentDashboardForward: ensureDashboard,
      verifyDeployment: verify,
      isDeploymentHealthy: vi.fn((result) => result.ok),
    });

    const result = await runFinalizationHandlers(baseOptions(deps));

    expect(ensureDashboard).toHaveBeenCalledWith("my-assistant", null);
    expect(ensureDashboard.mock.invocationCallOrder[0]).toBeGreaterThan(
      recoverProcesses.mock.invocationCallOrder[1],
    );
    expect(ensureDashboard.mock.invocationCallOrder[0]).toBeLessThan(
      verify.mock.invocationCallOrder[0],
    );
    expect(result.deploymentHealthy).toBe(true);
    expect(result.stateResult.type).toBe("complete");
  });

  it("persists the dashboard port selected after final recovery (#8214)", async () => {
    const persistDashboardPort = vi.fn();
    const { deps } = createDeps({
      ensureAgentDashboardForward: vi.fn(() => 18792),
      persistDashboardPort,
    });

    await handleFinalizationPhase({
      ...baseOptions(deps),
      agent: { name: "hermes" },
    });

    expect(persistDashboardPort).toHaveBeenCalledWith("my-assistant", 18792);
  });

  it("does not persist a zero dashboard port after final recovery (#8214)", async () => {
    const persistDashboardPort = vi.fn();
    const { deps } = createDeps({
      ensureAgentDashboardForward: vi.fn(() => 0),
      persistDashboardPort,
    });

    await handleFinalizationPhase({
      ...baseOptions(deps),
      agent: { name: "hermes" },
    });

    expect(persistDashboardPort).not.toHaveBeenCalled();
  });

  it("ensures agent dashboard forwarding before completion for non-OpenClaw agents", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes" };

    await runFinalizationHandlers({ ...baseOptions(deps), agent });

    expect(calls.ensureAgentDashboard).toHaveBeenCalledWith("my-assistant", agent);
    expect(calls.ensureAgentDashboard.mock.invocationCallOrder[0]).toBeLessThan(
      calls.dashboard.mock.invocationCallOrder[0],
    );
    expect(calls.dashboard).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      agent,
      true,
    );
  });

  it("rechecks gateway and forwarding after finalization work and before verification", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "openclaw" };

    await runFinalizationHandlers({
      ...baseOptions(deps),
      agent,
      webSearchEnabled: true,
      webSearchProvider: "brave",
    });

    const recoveryOrders = calls.recoverProcesses.mock.invocationCallOrder;
    const refreshOrder = calls.ensureAgentDashboard.mock.invocationCallOrder[0];
    expect(recoveryOrders).toHaveLength(2);
    expect(recoveryOrders[1]).toBeGreaterThan(calls.warmupScopeUpgrade.mock.invocationCallOrder[0]);
    expect(recoveryOrders[1]).toBeGreaterThan(
      calls.autoPairScopeApproval.mock.invocationCallOrder[0],
    );
    expect(refreshOrder).toBeGreaterThan(recoveryOrders[1]);
    expect(calls.verifyWebSearch.mock.invocationCallOrder[0]).toBeGreaterThan(refreshOrder);
    expect(refreshOrder).toBeLessThan(calls.verify.mock.invocationCallOrder[0]);
    expect(calls.verifyWebSearch.mock.invocationCallOrder[0]).toBeLessThan(
      calls.verify.mock.invocationCallOrder[0],
    );
  });

  it("skips dashboard and gateway verification for terminal agents without forwards", async () => {
    const { deps, calls } = createDeps();
    const agent = {
      name: "langchain-deepagents-code",
      displayName: "LangChain Deep Agents Code",
      runtime: {
        kind: "terminal",
        interactive_command: "dcode",
        headless_command: "dcode -n",
      },
    };

    const result = await runFinalizationHandlers({
      ...baseOptions(deps),
      agent,
      webSearchEnabled: true,
    });

    expect(calls.ensureAgentDashboard).not.toHaveBeenCalled();
    expect(calls.recoverProcesses).not.toHaveBeenCalled();
    expect(calls.autoPairScopeApproval).not.toHaveBeenCalled();
    expect(calls.getChatUiUrl).not.toHaveBeenCalled();
    expect(calls.buildChain).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.diagnostics).not.toHaveBeenCalled();
    expect(calls.verifyWebSearch).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
    expect(calls.log).toHaveBeenCalledWith(
      "  ✓ LangChain Deep Agents Code terminal runtime is ready",
    );
    expect(calls.log).toHaveBeenCalledWith("  Launch: nemoclaw launch my-assistant");
    expect(calls.log).toHaveBeenCalledWith("  Connect: nemoclaw my-assistant connect");
    expect(calls.log).toHaveBeenCalledWith("  Interactive: dcode");
    expect(calls.log).toHaveBeenCalledWith('  Headless: dcode -n "<task>"');
    expect(calls.log.mock.calls.map(([line]) => line).join("\n")).not.toContain("Port 0");
    expect(result.verificationDiagnostics).toEqual([]);
    expect(result.stateResult.type).toBe("complete");
  });

  it("does not complete the session when deployment verification fails", async () => {
    const { deps, calls } = createDeps({
      verifyDeployment: vi.fn(async () => {
        throw new Error("verification failed");
      }),
    });

    await expect(runFinalizationHandlers(baseOptions(deps))).rejects.toThrow("verification failed");

    expect(calls.dashboard).not.toHaveBeenCalled();
    // The sandbox reached finalization (policies confirmed), so it stays the default
    // even when post-policy verification flakes — only a pre-policy cancel rolls back.
    expect(calls.setDefaultSandbox).toHaveBeenCalledWith("my-assistant");
  });

  it("removes legacy credentials only when all staged values migrated", async () => {
    const { deps, calls } = createDeps();

    await runFinalizationHandlers({
      ...baseOptions(deps),
      stagedLegacyKeys: ["NVIDIA_INFERENCE_API_KEY", "SLACK_BOT_TOKEN"],
      migratedLegacyKeys: new Set(["NVIDIA_INFERENCE_API_KEY", "SLACK_BOT_TOKEN"]),
    });

    expect(calls.removeLegacy).toHaveBeenCalledOnce();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("keeps legacy credentials and warns when migration is incomplete", async () => {
    const { deps, calls } = createDeps();

    const result = await runFinalizationHandlers({
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
    await runFinalizationHandlers(baseOptions(depsOff));
    expect(callsOff.verifyWebSearch).not.toHaveBeenCalled();

    const { deps: depsOn, calls: callsOn } = createDeps();
    const agent = { name: "openclaw" };
    await runFinalizationHandlers({
      ...baseOptions(depsOn),
      agent,
      webSearchEnabled: true,
      webSearchProvider: "brave",
    });
    expect(callsOn.verifyWebSearch).toHaveBeenCalledWith("my-assistant", agent, "brave");
    // Probe runs after sandbox-process recovery so the post-policy state is live.
    expect(callsOn.verifyWebSearch.mock.invocationCallOrder[0]).toBeGreaterThan(
      callsOn.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(callsOn.verifyWebSearch.mock.invocationCallOrder[0]).toBeLessThan(
      callsOn.verify.mock.invocationCallOrder[0],
    );
  });

  it("does not complete when web-search credentials are exposed in the sandbox (#7425)", async () => {
    const { deps, calls } = createDeps({
      verifyWebSearchInsideSandbox: vi.fn(() => false),
    });
    const agent = { name: "openclaw" };

    const result = await runFinalizationHandlers({
      ...baseOptions(deps),
      agent,
      webSearchEnabled: true,
      webSearchProvider: "brave",
    });

    expect(result.deploymentHealthy).toBe(false);
    expect(result.stateResult).toMatchObject({
      type: "pause",
      metadata: { reason: "deployment_not_ready" },
    });
    expect(calls.dashboard).toHaveBeenCalledWith(
      "my-assistant",
      "model",
      "provider",
      null,
      agent,
      false,
    );
    expect(calls.reportReadiness).toHaveBeenCalledWith(false);
  });

  // Scenario A (#4504): the auto-pair scope-approval sweep runs against the
  // freshly-recovered gateway — strictly after process recovery (which can
  // restart the gateway, #3573) and strictly before deployment verification
  // (so the gateway state is settled before we probe it).
  it("runs the auto-pair scope-approval sweep after process recovery and before verify (#4504)", async () => {
    const { deps, calls } = createDeps();

    await runFinalizationHandlers(baseOptions(deps));

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

    await runFinalizationHandlers({ ...baseOptions(deps), agent });

    expect(calls.autoPairScopeApproval).toHaveBeenCalledWith("my-assistant");
  });

  // Scenario C (#4504): the dep is documented as best-effort / never-throws and
  // the handler wraps no try/catch around it. Per the contract we assert the
  // implemented behavior: the sweep is invoked and, because it returns cleanly,
  // post verification proceeds to completion. A dependency that threw would
  // abort finalization here — the regression this guards.
  it("treats the scope-approval sweep as best-effort and still completes the session (#4504)", async () => {
    const { deps, calls } = createDeps();

    const result = await runFinalizationHandlers(baseOptions(deps));

    expect(calls.autoPairScopeApproval).toHaveBeenCalledOnce();
    // The non-throwing sweep does not abort finalization: it proceeds through
    // verification and the dashboard print to a completed result. (#4472 moved
    // session completion to the imported completeOnboardMachine, so completion
    // is asserted via the downstream dashboard + diagnostics rather than a dep.)
    expect(calls.dashboard).toHaveBeenCalledOnce();
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });

  // Scenario 1 (#4504-v2, HEADLINE): the warm-up provokes the operator.write
  // scope upgrade so the approval pass below has something pending to approve.
  // The order is load-bearing: process recovery (gateway live) → warmup
  // (provoke / create pending) → autoPairScopeApproval (approve / clear
  // pending). Reversing warmup and approval makes the approval pass a no-op and
  // the user's first real run falls back — exactly the bug v2 fixes.
  it("provokes the scope upgrade after recovery and before the approval pass in v2 (#4504)", async () => {
    const { deps, calls } = createDeps();

    await runFinalizationHandlers(baseOptions(deps));

    expect(calls.warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(calls.warmupScopeUpgrade).toHaveBeenCalledWith("my-assistant");
    // recover → warmup (provoke) → autoPairScopeApproval (approve).
    expect(calls.warmupScopeUpgrade.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(calls.warmupScopeUpgrade.mock.invocationCallOrder[0]).toBeLessThan(
      calls.autoPairScopeApproval.mock.invocationCallOrder[0],
    );
  });

  // Scenario 2 (#4504-v2): the warm-up is best-effort / non-blocking. The
  // handler wraps no try/catch around the dep and relies on the dep itself
  // never throwing (the production leaf swallows every failure — covered in
  // auto-pair-warmup.test.ts). Per the contract we assert the implemented
  // behavior here: the warm-up is invoked and, because the (non-throwing) dep
  // returns cleanly, finalization is NOT ordered to depend on its success — it
  // proceeds straight to the approval pass, verification, and the dashboard.
  // The dep returning nothing useful (no pending provoked, gateway slow) does
  // not change the downstream flow: behavior degrades to v1, never blocks.
  it("completes v2 finalization without depending on the warm-up succeeding (#4504)", async () => {
    // The default warm-up mock returns undefined (e.g. gateway not up → the
    // production leaf swallowed and provoked nothing). Finalization must be
    // unaffected.
    const { deps, calls } = createDeps();

    const result = await runFinalizationHandlers(baseOptions(deps));

    expect(calls.warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(calls.warmupScopeUpgrade.mock.results[0]).toEqual({ type: "return", value: undefined });
    // The approval pass still runs after it (degrades to v1, not skipped).
    expect(calls.autoPairScopeApproval).toHaveBeenCalledOnce();
    expect(calls.dashboard).toHaveBeenCalledOnce();
    expect(result.verificationDiagnostics).toEqual(["  ✓ verified"]);
  });

  // Scenario 3 (#4504-v2): the warm-up is agent-agnostic — the first-run scope
  // upgrade is provoked regardless of which agent the sandbox runs (the
  // contract says run it unconditionally; idempotent once operator.write is
  // paired).
  it("provokes the v2 scope upgrade regardless of agent type (#4504)", async () => {
    const { deps: depsHermes, calls: callsHermes } = createDeps();
    await runFinalizationHandlers({ ...baseOptions(depsHermes), agent: { name: "hermes" } });
    expect(callsHermes.warmupScopeUpgrade).toHaveBeenCalledWith("my-assistant");

    const { deps: depsOpenclaw, calls: callsOpenclaw } = createDeps();
    await runFinalizationHandlers({ ...baseOptions(depsOpenclaw), agent: { name: "openclaw" } });
    expect(callsOpenclaw.warmupScopeUpgrade).toHaveBeenCalledWith("my-assistant");
  });
});
