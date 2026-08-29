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
    settleOrdinaryPairing: vi.fn(async () => ({ kind: "settled" as const })),
    ordinaryPairingIncompleteMessage: vi.fn(
      () => "OpenClaw onboarding is incomplete; resume onboarding.",
    ),
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
      settleOrdinaryOpenClawPairing: calls.settleOrdinaryPairing,
      ordinaryOpenClawPairingIncompleteMessage: calls.ordinaryPairingIncompleteMessage,
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
  it("refuses finalization before its first mutation when policy authority drifts (#9833)", async () => {
    const revalidatePolicyRequirements = vi.fn(() => {
      throw new Error("policy authority changed");
    });
    const { deps, calls } = createDeps({ revalidatePolicyRequirements });

    await expect(handleFinalizationPhase(baseOptions(deps))).rejects.toThrow(
      "policy authority changed",
    );

    expect(calls.setDefaultSandbox).not.toHaveBeenCalled();
    expect(calls.removeLegacy).not.toHaveBeenCalled();
    expect(calls.cleanupHost).not.toHaveBeenCalled();
    expect(calls.recoverProcesses).not.toHaveBeenCalled();
  });

  it("refuses post-verification before pairing or success publication after drift (#9833)", async () => {
    const revalidatePolicyRequirements = vi.fn(() => {
      throw new Error("policy authority changed");
    });
    const { deps, calls } = createDeps({ revalidatePolicyRequirements });

    await expect(
      handlePostVerifyState({
        ...baseOptions(deps),
        agent: { name: "openclaw" },
        portableProfileSelected: true,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(calls.settlePortablePairing).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
    expect(calls.reportReadiness).not.toHaveBeenCalled();
  });

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

  it("uses strict Portable settlement instead of ordinary pairing settlement (#9207)", async () => {
    const { deps, calls } = createDeps();
    const options = {
      ...baseOptions(deps),
      agent: { name: "openclaw" },
      portableProfileSelected: true,
    };

    const result = await runFinalizationHandlers(options);

    expect(result.stateResult.type).toBe("complete");
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
    expect(calls.settlePortablePairing).toHaveBeenCalledExactlyOnceWith("my-assistant", {
      portableRequired: true,
    });
  });

  it("uses strict Portable settlement for the default-null OpenClaw resume state (#9200)", async () => {
    const { deps, calls } = createDeps({ readRegistryAgent: vi.fn(() => null) });
    const options = {
      ...baseOptions(deps),
      agent: null,
      portableProfileSelected: true,
    };

    const result = await runFinalizationHandlers(options);

    expect(result.stateResult.type).toBe("complete");
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
    expect(calls.settlePortablePairing).toHaveBeenCalledExactlyOnceWith("my-assistant", {
      portableRequired: true,
    });
  });

  it("passes the bound policy check through pairing settlement (#9833)", async () => {
    const revalidatePolicyRequirements = vi.fn();
    const portable = createDeps({ revalidatePolicyRequirements });

    await runFinalizationHandlers({
      ...baseOptions(portable.deps),
      agent: { name: "openclaw" },
      portableProfileSelected: true,
    });

    expect(portable.calls.settlePortablePairing).toHaveBeenCalledExactlyOnceWith("my-assistant", {
      portableRequired: true,
      revalidatePolicyRequirements,
    });

    const ordinary = createDeps({ revalidatePolicyRequirements });
    await runFinalizationHandlers(baseOptions(ordinary.deps));

    expect(ordinary.calls.settleOrdinaryPairing).toHaveBeenCalledExactlyOnceWith(
      "my-assistant",
      revalidatePolicyRequirements,
    );
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
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
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
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
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
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
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

  it("withholds dashboard-port persistence when authority drifts after forwarding (#9833)", async () => {
    const persistDashboardPort = vi.fn();
    const refuseDashboardPersistence = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["persist the dashboard port for sandbox 'my-assistant'", refuseDashboardPersistence],
    ]);
    const revalidatePolicyRequirements = vi.fn<(operation: string) => void>((operation) =>
      policyChecks.get(operation)?.(),
    );
    const ensureAgentDashboardForward = vi.fn(
      (_sandboxName, _agent, revalidate?: (operation: string) => void) => {
        revalidate?.("start dashboard forward");
        return 18792;
      },
    );
    const { deps } = createDeps({
      ensureAgentDashboardForward,
      persistDashboardPort,
      revalidatePolicyRequirements,
    });

    await expect(
      handleFinalizationPhase({
        ...baseOptions(deps),
        agent: { name: "hermes" },
      }),
    ).rejects.toThrow("policy authority changed");

    expect(ensureAgentDashboardForward).toHaveBeenCalledWith(
      "my-assistant",
      { name: "hermes" },
      revalidatePolicyRequirements,
    );
    expect(persistDashboardPort).not.toHaveBeenCalled();
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
    expect(calls.settleOrdinaryPairing).toHaveBeenCalledExactlyOnceWith("my-assistant");
    expect(recoveryOrders[1]).toBeGreaterThan(
      calls.settleOrdinaryPairing.mock.invocationCallOrder[0],
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
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
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

  it("withholds verified deployment output when authority drifts during the probe (#9833)", async () => {
    const refuseStatusPublication = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["publish deployment status for sandbox 'my-assistant'", refuseStatusPublication],
    ]);
    const revalidatePolicyRequirements = vi.fn<(operation: string) => void>((operation) =>
      policyChecks.get(operation)?.(),
    );
    const { deps, calls } = createDeps({ revalidatePolicyRequirements });

    await expect(runFinalizationHandlers(baseOptions(deps))).rejects.toThrow(
      "policy authority changed",
    );

    expect(calls.verify).toHaveBeenCalledOnce();
    expect(calls.log).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
    expect(calls.reportReadiness).not.toHaveBeenCalled();
    expect(revalidatePolicyRequirements).not.toHaveBeenCalledWith(
      "complete onboarding for sandbox 'my-assistant'",
    );
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

  it("settles ordinary OpenClaw pairing after recovery and before verification (#9844)", async () => {
    const { deps, calls } = createDeps();

    await runFinalizationHandlers(baseOptions(deps));

    expect(calls.settleOrdinaryPairing).toHaveBeenCalledExactlyOnceWith("my-assistant");
    expect(calls.settleOrdinaryPairing.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(calls.settleOrdinaryPairing.mock.invocationCallOrder[0]).toBeLessThan(
      calls.recoverProcesses.mock.invocationCallOrder[1],
    );
    expect(calls.recoverProcesses.mock.invocationCallOrder[1]).toBeLessThan(
      calls.verify.mock.invocationCallOrder[0],
    );
  });

  it("does not settle ordinary OpenClaw pairing during an inner rebuild handoff (#9844)", async () => {
    const { deps, calls } = createDeps();

    const result = await runFinalizationHandlers({
      ...baseOptions(deps),
      recreateJournalHandoff: true,
    });

    expect(result.stateResult.type).toBe("complete");
    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
    expect(calls.ensureAgentDashboard).toHaveBeenCalledWith("my-assistant", null);
    expect(calls.verify).toHaveBeenCalledOnce();
  });

  it("does not run OpenClaw pairing settlement for Hermes (#9844)", async () => {
    const { deps, calls } = createDeps();
    const agent = { name: "hermes" };

    await runFinalizationHandlers({ ...baseOptions(deps), agent });

    expect(calls.settleOrdinaryPairing).not.toHaveBeenCalled();
  });

  it("pauses onboarding when canonical OpenClaw pairing does not settle (#9844)", async () => {
    const { deps, calls } = createDeps({
      settleOrdinaryOpenClawPairing: vi.fn(async () => ({
        kind: "incomplete" as const,
        reason: "pairing-unavailable" as const,
      })),
    });

    const result = await runFinalizationHandlers(baseOptions(deps));

    expect(result).toMatchObject({
      deploymentHealthy: false,
      stateResult: {
        type: "pause",
        metadata: { state: "post_verify", reason: "deployment_not_ready" },
      },
    });
    expect(result.verificationDiagnostics).toEqual([
      "OpenClaw onboarding is incomplete; resume onboarding.",
    ]);
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dashboard).not.toHaveBeenCalled();
    expect(calls.ensureAgentDashboard).not.toHaveBeenCalled();
    expect(calls.reportReadiness).toHaveBeenCalledWith(false);
    expect(calls.error).toHaveBeenCalledWith(
      "  OpenClaw onboarding is incomplete; resume onboarding.",
    );
  });
});
