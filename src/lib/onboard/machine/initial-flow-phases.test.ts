// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../state/onboard-session";
import { resolveGatewayOwner } from "../gateway-ownership";
import {
  createInitialOnboardFlowPhases,
  getInitialGatewayReuseStateForOwner,
  type InitialOnboardFlowContext,
  runInitialOnboardFlowSlice,
} from "./initial-flow-phases";
import type { OnboardPrerequisiteRepairEventRecorder } from "./prerequisite-repair";
import { advanceTo } from "./result";
import type { OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

type Gpu = { type: "nvidia"; platform: "linux" | "jetson" } | null;
type SandboxGpuConfig = {
  sandboxGpuEnabled: boolean;
  mode: string;
  hostGpuPlatform: string | null;
  sandboxGpuDevice?: string | null;
  errors?: string[];
};
type Context = InitialOnboardFlowContext<null, Gpu, SandboxGpuConfig>;

function context(overrides: Partial<Context> = {}): Context {
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
    compatibleEndpointReasoning: null,

    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
    resumeHasResolvedGpuIntent: false,
    requestedGpuPassthrough: false,
    ...overrides,
  };
}

function config(gpu: Gpu): SandboxGpuConfig {
  return {
    sandboxGpuEnabled: Boolean(gpu),
    mode: gpu ? "1" : "0",
    hostGpuPlatform: gpu?.platform ?? null,
    sandboxGpuDevice: null,
    errors: [],
  };
}

function runtime(session: Session = createSession()): OnboardMachineRunnerRuntime {
  return {
    session: async () => session,
    applyResult: async (result) => {
      if (result.type === "transition") {
        session.machine = {
          ...session.machine,
          state: result.next,
          revision: session.machine.revision + 1,
        };
      }
      return session;
    },
  };
}

function repairRecorder(events: string[] = []): OnboardPrerequisiteRepairEventRecorder {
  return async (type, options) => {
    events.push(`${type}:${options.state ?? "unknown"}`);
  };
}

function completeStep(): Session["steps"][string] {
  return {
    status: "complete",
    startedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:01:00.000Z",
    error: null,
  };
}

describe("initial onboard flow phases", () => {
  it("does not run managed gateway selection for an external owner (#7411)", () => {
    const owner = resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 31818,
      declaration: {
        version: 1,
        mode: "externally-supervised",
        endpoint: "http://127.0.0.1:31818",
        stateDir: "/var/lib/openshell/gateway",
        supervisor: {
          kind: "systemd-system",
          serviceName: "openshell-gateway.service",
          execPath: "/usr/local/bin/openshell-gateway",
        },
        requiredCapabilities: [],
      },
      hasPackagedService: false,
    });
    const getManagedReuseState = vi.fn(() => "healthy" as const);

    expect(getInitialGatewayReuseStateForOwner(owner, getManagedReuseState)).toBe("missing");
    expect(getManagedReuseState).not.toHaveBeenCalled();
  });

  it("carries preflight GPU output into the gateway phase", async () => {
    const notes: string[] = [];
    const gpu: Gpu = { type: "nvidia", platform: "linux" };
    let preflightFailure: Error | null = null;
    const commitSelectedAgentTransition = vi.fn(async () => createSession());
    const phases = createInitialOnboardFlowPhases({
      explicitSandboxGpuFlag: null,
      sandboxGpuDevice: null,
      gpuRequested: true,
      noGpu: false,
      env: {},
      platform: "darwin",
      recordedGpuPassthroughBeforePreflight: false,
      commitSelectedAgentTransition,
      ensureResumePreflightDashboardPortAvailable: vi.fn(),
      preflightDeps: {
        getSandbox: () => null,
        getResumeSandboxGpuOverrides: () => ({ flag: null, device: null }),
        detectGpuForReadiness: () => gpu,
        detectGpu: () => gpu,
        runPreflight: async () => (preflightFailure ? Promise.reject(preflightFailure) : gpu),
        assessHost: () => ({}),
        assertOnboardHostReadiness: vi.fn(),
        assertDockerBridgeAndContainerDnsHealthy: vi.fn(),
        resolveSandboxGpuConfig: config,
        validateSandboxGpuPreflight: vi.fn(),
        skippedStepMessage: vi.fn(),
        recordStateSkipped: async () => createSession(),
        startRecordedStep: vi.fn(),
        recordStepComplete: async () => createSession(),
        updateSession: (mutator) => {
          const next = createSession();
          return mutator(next) ?? next;
        },
      },
      getInitialGatewayReuseState: () => "healthy",
      assertGatewayReadiness: vi.fn(async () => undefined),
      gatewayName: "nemoclaw",
      recreateSandbox: () => false,
      gatewayDeps: {
        resolveGatewayOwner: () =>
          resolveGatewayOwner({
            gatewayName: "nemoclaw",
            gatewayPort: 31818,
            declaration: null,
            hasPackagedService: false,
          }),
        attachGateway: vi.fn(),
        probeGatewayAttachment: async () => ({
          gatewayPort: 31818,
          httpReady: true,
          portOccupied: true,
          listenerPids: [4242],
          listenerScanComplete: true,
          listenerStartTime: null,
          supervisorActive: null,
          listenerExecPath: null,
          listenerSupervisorMatch: null,
        }),
        refreshDockerDriverGatewayReuseState: async (state) => state,
        gatewayCliSupportsLifecycleCommands: () => false,
        verifyGatewayContainerRunning: () => "running",
        waitForGatewayHttpReady: async () => true,
        recoverGatewayRuntime: async () => true,
        getGatewayLocalEndpoint: () => "http://127.0.0.1:31818",
        stopDashboardForward: vi.fn(),
        destroyGateway: () => true,
        destroyGatewayForReuse: () => "missing",
        getGatewayClusterImageDrift: () => null,
        stopAllDashboardForwards: vi.fn(),
        reconcileGatewayGpuReuseForGpuIntent: (options) => options.gatewayReuseState,
        isLinuxDockerDriverGatewayEnabled: () => false,
        retireLegacyGatewayForDockerDriverUpgrade: vi.fn(),
        destroyGatewayRuntimeForGpuReuse: () => true,
        skippedStepMessage: vi.fn(),
        recordStateSkipped: async () => createSession(),
        note: (message) => notes.push(message),
        startRecordedStep: vi.fn(),
        startGateway: vi.fn(),
        recordStepComplete: async () => createSession(),
        exitProcess: (code) => {
          throw new Error(`exit ${code}`);
        },
      },
      note: (message) => notes.push(message),
    });

    const preflight = await phases[0].run(context());
    const gateway = await phases[1].run(preflight.context);

    expect(preflight.context.gpu).toEqual(gpu);
    expect(preflight.context.sandboxGpuConfig).toEqual(config(gpu));
    expect(preflight.context.gpuPassthrough).toBe(true);
    expect(gateway.result).toEqual(
      advanceTo("provider_selection", {
        metadata: {
          state: "gateway",
          gatewayReuseState: "healthy",
          gatewayOwner: {
            gatewayName: "nemoclaw",
            gatewayPort: 31818,
            mode: "nemoclaw-managed",
            source: "standalone",
            endpoint: null,
            supervisor: null,
            requiredCapabilities: [],
          },
        },
      }),
    );
    expect(notes).toContain(
      "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation.",
    );
    expect(commitSelectedAgentTransition).toHaveBeenCalledOnce();

    commitSelectedAgentTransition.mockClear();
    preflightFailure = new Error("readiness blocked");
    await expect(phases[0].run(context())).rejects.toThrow("readiness blocked");
    expect(commitSelectedAgentTransition).not.toHaveBeenCalled();
  });

  it("repairs preflight before strict gateway entry", async () => {
    const events: string[] = [];
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => ({
          context: ctx,
          result: advanceTo("gateway", { metadata: { state: "preflight" } }),
        }),
      },
      {
        state: "gateway",
        run: (ctx) => ({
          context: ctx,
          result: advanceTo("provider_selection", { metadata: { state: "gateway" } }),
        }),
      },
    ];

    await runInitialOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: runtime(
        createSession({
          machine: {
            version: 1,
            state: "gateway",
            stateEnteredAt: "2026-06-09T00:00:00.000Z",
            revision: 2,
          },
        }),
      ),
      phases,
      resume: true,
      recordRepairEvent: repairRecorder(events),
    });

    expect(events).toEqual(["state.repair.started:preflight", "state.repair.completed:preflight"]);
  });

  it("returns the runtime session after strict gateway entry", async () => {
    const phaseSession = createSession({
      machine: {
        version: 1,
        state: "gateway",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 2,
      },
    });
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "gateway",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 2,
      },
    });
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => ({
          context: { ...ctx, session: phaseSession },
          result: advanceTo("gateway", { metadata: { state: "preflight" } }),
        }),
      },
      {
        state: "gateway",
        run: (ctx) => ({
          context: { ...ctx, session: phaseSession },
          result: advanceTo("provider_selection", { metadata: { state: "gateway" } }),
        }),
      },
    ];

    const result = await runInitialOnboardFlowSlice({
      context: context({ resume: true, session: phaseSession }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async (stateResult) => {
          if (stateResult.type === "transition") {
            runtimeSession.machine = {
              ...runtimeSession.machine,
              state: stateResult.next,
              revision: runtimeSession.machine.revision + 1,
            };
          }
          return runtimeSession;
        },
      },
      phases,
      resume: true,
      recordRepairEvent: repairRecorder(),
    });

    expect(result.context.session).toBe(phaseSession);
    expect(result.session).toBe(runtimeSession);
    expect(result.session.machine.state).toBe("provider_selection");
  });

  it("runs resume preflight and gateway backstops when saved machine state is already ahead", async () => {
    const calls: string[] = [];
    const gpu: Gpu = { type: "nvidia", platform: "linux" };
    const session = createSession({
      gpuPassthrough: true,
      machine: {
        version: 1,
        state: "provider_selection",
        stateEnteredAt: "2026-06-09T00:02:00.000Z",
        revision: 7,
      },
      steps: {
        preflight: completeStep(),
        gateway: completeStep(),
      },
    });
    const ensureResumePreflightDashboardPortAvailable = vi.fn(() => {
      calls.push("ensure-resume-preflight-port");
    });
    const phases = createInitialOnboardFlowPhases({
      explicitSandboxGpuFlag: null,
      sandboxGpuDevice: null,
      gpuRequested: false,
      noGpu: false,
      env: {},
      platform: "darwin",
      recordedGpuPassthroughBeforePreflight: true,
      commitSelectedAgentTransition: async () => {
        calls.push("commit-agent-transition");
        return session;
      },
      ensureResumePreflightDashboardPortAvailable,
      preflightDeps: {
        getSandbox: vi.fn(() => {
          calls.push("get-sandbox");
          return { name: "existing" };
        }),
        getResumeSandboxGpuOverrides: vi.fn(() => {
          calls.push("resume-gpu-overrides");
          return { flag: "enable" as const, device: null };
        }),
        detectGpuForReadiness: vi.fn(() => {
          calls.push("detect-gpu-readiness");
          return gpu;
        }),
        detectGpu: vi.fn(() => {
          calls.push("detect-gpu");
          return gpu;
        }),
        runPreflight: vi.fn(async () => {
          throw new Error("cached resume preflight should not run full preflight");
        }),
        assessHost: vi.fn(() => {
          calls.push("assess-host");
          return { docker: true };
        }),
        assertOnboardHostReadiness: vi.fn(() => {
          calls.push("assert-host-readiness");
        }),
        assertDockerBridgeAndContainerDnsHealthy: vi.fn(() => {
          calls.push("assert-bridge-dns");
        }),
        resolveSandboxGpuConfig: vi.fn((detectedGpu) => {
          calls.push("resolve-gpu-config");
          return config(detectedGpu);
        }),
        validateSandboxGpuPreflight: vi.fn(() => {
          calls.push("validate-gpu-preflight");
        }),
        skippedStepMessage: vi.fn(() => {
          calls.push("skip-preflight");
        }),
        recordStateSkipped: vi.fn(async () => {
          calls.push("record-preflight-skipped");
          return session;
        }),
        startRecordedStep: vi.fn(async () => {
          throw new Error("cached resume preflight should not start a recorded preflight step");
        }),
        recordStepComplete: vi.fn(async () => session),
        updateSession: vi.fn((mutator) => mutator(session) ?? session),
      },
      getInitialGatewayReuseState: () => {
        calls.push("initial-gateway-reuse-state");
        return "healthy";
      },
      assertGatewayReadiness: vi.fn(async () => {
        calls.push("assert-gateway-readiness");
      }),
      gatewayName: "nemoclaw",
      recreateSandbox: () => false,
      gatewayDeps: {
        resolveGatewayOwner: () =>
          resolveGatewayOwner({
            gatewayName: "nemoclaw",
            gatewayPort: 31818,
            declaration: null,
            hasPackagedService: false,
          }),
        attachGateway: vi.fn(),
        probeGatewayAttachment: async () => ({
          gatewayPort: 31818,
          httpReady: true,
          portOccupied: true,
          listenerPids: [4242],
          listenerScanComplete: true,
          listenerStartTime: null,
          supervisorActive: null,
          listenerExecPath: null,
          listenerSupervisorMatch: null,
        }),
        refreshDockerDriverGatewayReuseState: vi.fn(async (state) => {
          calls.push("refresh-gateway-reuse");
          return state;
        }),
        gatewayCliSupportsLifecycleCommands: vi.fn(() => {
          calls.push("gateway-lifecycle-support");
          return false;
        }),
        verifyGatewayContainerRunning: vi.fn(() => {
          throw new Error("gateway lifecycle probe should not run without lifecycle support");
        }),
        waitForGatewayHttpReady: vi.fn(async () => true),
        recoverGatewayRuntime: vi.fn(async () => true),
        getGatewayLocalEndpoint: vi.fn(() => "http://127.0.0.1:31818"),
        stopDashboardForward: vi.fn(),
        destroyGateway: vi.fn(() => true),
        destroyGatewayForReuse: vi.fn(() => "missing" as const),
        getGatewayClusterImageDrift: vi.fn(() => null),
        stopAllDashboardForwards: vi.fn(),
        reconcileGatewayGpuReuseForGpuIntent: vi.fn((options) => {
          calls.push("reconcile-gateway-gpu");
          return options.gatewayReuseState;
        }),
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        retireLegacyGatewayForDockerDriverUpgrade: vi.fn(),
        destroyGatewayRuntimeForGpuReuse: vi.fn(() => true),
        skippedStepMessage: vi.fn(() => {
          calls.push("skip-gateway");
        }),
        recordStateSkipped: vi.fn(async () => {
          calls.push("record-gateway-skipped");
          return session;
        }),
        note: vi.fn(),
        startRecordedStep: vi.fn(async () => {
          throw new Error("healthy resume gateway should not start a recorded gateway step");
        }),
        startGateway: vi.fn(async () => {
          throw new Error("healthy resume gateway should not start a new gateway");
        }),
        recordStepComplete: vi.fn(async () => {
          calls.push("record-gateway-complete");
          return session;
        }),
        exitProcess: (code) => {
          throw new Error(`exit ${code}`);
        },
      },
      note: vi.fn(),
    });
    const repairEvents: string[] = [];

    const result = await runInitialOnboardFlowSlice({
      context: context({
        resume: true,
        session,
        recordedSandboxName: "existing",
        gpuPassthrough: true,
      }),
      runtime: runtime(session),
      phases,
      resume: true,
      recordRepairEvent: repairRecorder(repairEvents),
    });

    expect(result.session.machine.state).toBe("provider_selection");
    expect(ensureResumePreflightDashboardPortAvailable).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "get-sandbox",
      "resume-gpu-overrides",
      "skip-preflight",
      "record-preflight-skipped",
      "assess-host",
      "detect-gpu-readiness",
      "resolve-gpu-config",
      "assert-gateway-readiness",
      "assert-host-readiness",
      "detect-gpu",
      "assess-host",
      "resolve-gpu-config",
      "assert-gateway-readiness",
      "assert-host-readiness",
      "validate-gpu-preflight",
      "assert-bridge-dns",
      "resolve-gpu-config",
      "ensure-resume-preflight-port",
      "commit-agent-transition",
      "assert-gateway-readiness",
      "initial-gateway-reuse-state",
      "refresh-gateway-reuse",
      "gateway-lifecycle-support",
      "reconcile-gateway-gpu",
      "skip-gateway",
      "record-gateway-skipped",
      "record-gateway-complete",
    ]);
    expect(repairEvents).toEqual([
      "state.repair.started:preflight",
      "state.repair.completed:preflight",
      "state.repair.started:gateway",
      "state.repair.completed:gateway",
    ]);
    // Repair context must carry the current GPU observation into sandbox setup.
    expect(result.context.sandboxGpuConfig).toEqual(config(gpu));
    expect(result.context.gpu).toEqual(gpu);
    expect(result.context.gpuPassthrough).toBe(true);
  });

  it.each([
    "inference",
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("repairs initial prerequisites for resumed %s entry", async (state) => {
    const repairEvents: string[] = [];
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => ({
          context: ctx,
          result: advanceTo("gateway", { metadata: { state: "preflight" } }),
        }),
      },
      {
        state: "gateway",
        run: (ctx) => ({
          context: ctx,
          result: advanceTo("provider_selection", { metadata: { state: "gateway" } }),
        }),
      },
    ];

    await runInitialOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: runtime(
        createSession({
          machine: {
            version: 1,
            state,
            stateEnteredAt: "2026-06-09T00:00:00.000Z",
            revision: 7,
          },
        }),
      ),
      phases,
      resume: true,
      recordRepairEvent: repairRecorder(repairEvents),
    });

    expect(repairEvents).toEqual([
      "state.repair.started:preflight",
      "state.repair.completed:preflight",
      "state.repair.started:gateway",
      "state.repair.completed:gateway",
    ]);
  });

  it.each(["complete", "failed"] as const)(
    "rejects terminal %s sessions before initial repair effects",
    async (state) => {
      const phase: OnboardSequencePhase<Context> = {
        state: "preflight",
        run: vi.fn((ctx) => ({
          context: ctx,
          result: advanceTo("gateway", { metadata: { state: "preflight" } }),
        })),
      };

      await expect(
        runInitialOnboardFlowSlice({
          context: context({ resume: true }),
          runtime: runtime(
            createSession({
              machine: {
                version: 1,
                state,
                stateEnteredAt: "2026-06-09T00:00:00.000Z",
                revision: 7,
              },
            }),
          ),
          phases: [phase],
          resume: true,
          recordRepairEvent: repairRecorder(),
        }),
      ).rejects.toThrow("Unexpected onboarding flow state before slice entry");
      expect(phase.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runKind: "fresh", resume: false },
    { runKind: "resumed", resume: true },
  ])("uses the strict runner for $runKind preflight sessions", async ({ resume }) => {
    const order: string[] = [];
    const applied: string[] = [];
    const session = createSession({
      machine: {
        version: 1,
        state: "preflight",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 1,
      },
    });
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => {
          order.push("preflight");
          return { context: ctx, result: advanceTo("gateway") };
        },
      },
      {
        state: "gateway",
        run: (ctx) => {
          order.push("gateway");
          return { context: ctx, result: advanceTo("provider_selection") };
        },
      },
    ];

    const result = await runInitialOnboardFlowSlice({
      context: context({ resume, session }),
      runtime: {
        session: async () => session,
        applyResult: async (stateResult) => {
          const next = (stateResult as ReturnType<typeof advanceTo>).next;
          applied.push(next);
          session.machine = {
            ...session.machine,
            state: next,
            revision: session.machine.revision + 1,
          };
          return session;
        },
      },
      phases,
      resume,
      recordRepairEvent: async () => {
        throw new Error("repair recorder should not run on the exact-entry path");
      },
    });

    expect(order).toEqual(["preflight", "gateway"]);
    expect(applied).toEqual(["gateway", "provider_selection"]);
    expect(result.session.machine.state).toBe("provider_selection");
  });

  it.each([
    { runKind: "fresh", resume: false },
    { runKind: "resumed", resume: true },
  ])("uses the strict runner for $runKind init sessions", async ({ resume }) => {
    const order: string[] = [];
    const applied: string[] = [];
    const session = createSession();
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => {
          order.push("preflight");
          return { context: ctx, result: advanceTo("gateway") };
        },
      },
      {
        state: "gateway",
        run: (ctx) => {
          order.push("gateway");
          return { context: ctx, result: advanceTo("provider_selection") };
        },
      },
    ];

    const result = await runInitialOnboardFlowSlice({
      context: context({ resume, session }),
      runtime: {
        session: async () => session,
        applyResult: async (stateResult) => {
          if (stateResult.type === "transition") {
            applied.push(stateResult.next);
            session.machine = {
              ...session.machine,
              state: stateResult.next,
              revision: session.machine.revision + 1,
            };
          }
          return session;
        },
      },
      phases,
      resume,
      recordRepairEvent: async () => {
        throw new Error("repair recorder should not run on the exact-entry path");
      },
    });

    expect(order).toEqual(["preflight", "gateway"]);
    expect(applied).toEqual(["preflight", "gateway", "provider_selection"]);
    expect(result.session.machine.state).toBe("provider_selection");
  });
});
