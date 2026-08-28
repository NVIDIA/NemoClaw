// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUpdates } from "../../state/onboard-session";
import type { FinalizationStateOptions } from "./handlers/finalization";

const mocks = vi.hoisted(() => ({
  handleSandboxState: vi.fn(),
}));

vi.mock("./handlers/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handlers/sandbox")>()),
  handleSandboxState: mocks.handleSandboxState,
}));

import { createSandboxOnboardFlowPhase } from "./core-flow-phases";
import { createFinalOnboardFlowPhases } from "./final-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import { branchTo } from "./result";
import { createSession } from "../../state/onboard-session";

type Agent = { name: string } | null;
type VerifyChain = { port: number };
type VerificationResult = { ok: boolean };

function context(): OnboardFlowContext<Agent, null, Record<string, never>> {
  return {
    resume: true,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: "alpha",
    requestedSandboxName: "alpha",
    sandboxName: "alpha",
    fromDockerfile: null,
    model: "model-a",
    provider: "nvidia",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: "openai",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: {},
    gpuPassthrough: false,
  };
}

/**
 * Dependencies for the real finalization handlers used by the rebuild handoff
 * test. The settlement and verification spies let the flow test prove the
 * public path: a journaled rebuild handoff must settle ordinary OpenClaw
 * pairing and finish settlement before deployment verification.
 */
function finalizationDeps(
  calls: ReturnType<typeof createFinalizationCalls>["calls"],
): FinalizationStateOptions<Agent, VerifyChain, VerificationResult>["deps"] {
  return {
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
  };
}

function createFinalizationCalls() {
  const calls = {
    ensureAgentDashboard: vi.fn(() => 18789),
    persistDashboardPort: vi.fn(),
    setDefaultSandbox: vi.fn(),
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
    diagnostics: vi.fn(() => []),
    verifyWebSearch: vi.fn(() => true),
    dashboard: vi.fn(),
    isHealthy: vi.fn(() => true),
    reportReadiness: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  };
  return { calls };
}

describe("rebuild pairing handoff", () => {
  beforeEach(() => {
    mocks.handleSandboxState.mockReset().mockResolvedValue({
      sandboxName: "alpha",
      webSearchConfig: null,
      webSearchConfigChanged: false,
      hermesToolGateways: [],
      selectedMessagingChannels: [],
      webSearchSupported: false,
      session: createSession(),
      stateResult: branchTo("openclaw", { metadata: { state: "sandbox" } }),
    });
  });

  it.each([{ fingerprint: "intent-1" }, { fingerprint: null }])(
    "keeps routing journal fingerprint $fingerprint to the sandbox resume decision (#9844)",
    async ({ fingerprint }) => {
      const phase = createSandboxOnboardFlowPhase({
        gatewayName: "nemoclaw",
        recreateJournalTargetIntentFingerprint: fingerprint,
        resumeAgentChanged: false,
        endpointProvenance: { getSandboxRegistryEntry: () => null },
        recreateSandbox: () => true,
        controlUiPort: null,
        rootDir: "/repo",
        env: {},
        deps: {} as never,
      });

      await phase.run(context());

      expect(mocks.handleSandboxState).toHaveBeenCalledWith(
        expect.objectContaining({ recreateJournalTargetIntentFingerprint: fingerprint }),
      );
    },
  );

  it("settles ordinary OpenClaw pairing before deployment verification on a rebuild handoff (#10479)", async () => {
    // Container recreation wipes the machine-local pairing state
    // (identity/devices are `backup: false` and removed on destroy), so a
    // rebuild handoff must reach finalization exactly like fresh onboarding:
    // the real final handlers settle ordinary OpenClaw pairing before the
    // deployment probe.
    const sandboxPhase = createSandboxOnboardFlowPhase({
      gatewayName: "nemoclaw",
      recreateJournalTargetIntentFingerprint: "intent-1",
      resumeAgentChanged: false,
      endpointProvenance: { getSandboxRegistryEntry: () => null },
      recreateSandbox: () => true,
      controlUiPort: null,
      rootDir: "/repo",
      env: {},
      deps: {} as never,
    });
    const sandboxResult = await sandboxPhase.run(context());
    const { calls } = createFinalizationCalls();

    // Hold pairing settlement open until the test proves the deployment probe
    // waits for it: `verifyDeployment` must not start while pairing is still
    // pending. A suppress-if-rebuild regression would let verification run
    // immediately, so this ordering is the observable contract under test.
    const events: string[] = [];
    let releasePairing!: () => void;
    const pairingGate = new Promise<void>((resolve) => {
      releasePairing = resolve;
    });
    calls.settleOrdinaryPairing.mockImplementation(async () => {
      events.push("pairing-started");
      await pairingGate;
      events.push("pairing-settled");
      return { kind: "settled" as const };
    });
    calls.verify.mockImplementation(async () => {
      events.push("verify");
      return { ok: true };
    });

    const phases = createFinalOnboardFlowPhases({
      branchState: "openclaw",
      agentSetupDeps: {
        persistDashboardPort: calls.persistDashboardPort,
      } as never,
      policiesDeps: {} as never,
      finalization: {
        stagedLegacyKeys: [],
        migratedLegacyKeys: new Set(),
        webSearchEnabled: () => false,
        webSearchProvider: () => "brave",
      },
      finalizationDeps: finalizationDeps(calls),
    });

    await phases[2].run(sandboxResult.context);
    const postVerifyRun = phases[3].run(sandboxResult.context);

    await vi.waitFor(() => {
      expect(events).toContain("pairing-started");
    });
    expect(events).not.toContain("verify");
    releasePairing();
    await postVerifyRun;

    expect(calls.settleOrdinaryPairing).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(calls.settleOrdinaryPairing.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recoverProcesses.mock.invocationCallOrder[0],
    );
    expect(events).toEqual(["pairing-started", "pairing-settled", "verify"]);
  });
});
