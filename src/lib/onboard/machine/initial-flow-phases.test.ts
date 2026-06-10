// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../state/onboard-session";
import {
  createInitialOnboardFlowPhases,
  type InitialOnboardFlowContext,
  runInitialOnboardFlowSlice,
} from "./initial-flow-phases";
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
    applyResult: async () => session,
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
  it("carries preflight GPU output into the gateway phase", async () => {
    const notes: string[] = [];
    const gpu: Gpu = { type: "nvidia", platform: "linux" };
    const phases = createInitialOnboardFlowPhases({
      explicitSandboxGpuFlag: null,
      sandboxGpuDevice: null,
      gpuRequested: true,
      noGpu: false,
      env: {},
      platform: "darwin",
      recordedGpuPassthroughBeforePreflight: false,
      ensureResumePreflightDashboardPortAvailable: vi.fn(),
      preflightDeps: {
        getSandbox: () => null,
        getResumeSandboxGpuOverrides: () => ({ flag: null, device: null }),
        detectGpu: () => gpu,
        runPreflight: async () => gpu,
        assessHost: () => ({}),
        assertCdiNvidiaGpuSpecPresent: vi.fn(),
        rejectUnsupportedContainerRuntime: vi.fn(),
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
      gatewayName: "nemoclaw",
      recreateSandbox: () => false,
      gatewayDeps: {
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
        metadata: { state: "gateway", gatewayReuseState: "healthy" },
      }),
    );
    expect(notes).toContain(
      "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation.",
    );
  });

  it("records each phase result on the resume compatibility path", async () => {
    const recorded: string[] = [];
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => ({ context: ctx, result: advanceTo("gateway") }),
      },
      {
        state: "gateway",
        run: (ctx) => ({ context: ctx, result: advanceTo("provider_selection") }),
      },
    ];

    await runInitialOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: runtime(),
      phases,
      resume: true,
      recordStateResult: async (result) => {
        if (result.type === "transition") recorded.push(result.next);
      },
    });

    expect(recorded).toEqual(["gateway", "provider_selection"]);
  });

  it("returns the runtime session after resume compatibility state recording", async () => {
    const phaseSession = createSession({
      machine: {
        version: 1,
        state: "preflight",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 0,
      },
    });
    let runtimeSession = createSession({
      machine: {
        version: 1,
        state: "preflight",
        stateEnteredAt: "2026-06-09T00:00:00.000Z",
        revision: 0,
      },
    });
    const phases: readonly OnboardSequencePhase<Context>[] = [
      {
        state: "preflight",
        run: (ctx) => ({
          context: { ...ctx, session: phaseSession },
          result: advanceTo("gateway"),
        }),
      },
    ];

    const result = await runInitialOnboardFlowSlice({
      context: context({ resume: true, session: phaseSession }),
      runtime: {
        session: async () => runtimeSession,
        applyResult: async () => {
          throw new Error("resume compatibility path should not use strict applyResult");
        },
      },
      phases,
      resume: true,
      recordStateResult: async (stateResult) => {
        if (stateResult.type === "transition") {
          runtimeSession = createSession({
            machine: {
              version: 1,
              state: stateResult.next,
              stateEnteredAt: "2026-06-09T00:01:00.000Z",
              revision: 1,
            },
          });
        }
      },
    });

    expect(result.context.session).toBe(phaseSession);
    expect(result.session).toBe(runtimeSession);
    expect(result.session.machine.state).toBe("gateway");
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
        assertCdiNvidiaGpuSpecPresent: vi.fn(() => {
          calls.push("assert-cdi");
        }),
        rejectUnsupportedContainerRuntime: vi.fn(() => {
          calls.push("reject-unsupported-runtime");
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
      gatewayName: "nemoclaw",
      recreateSandbox: () => false,
      gatewayDeps: {
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
    const recorded: string[] = [];

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
      recordStateResult: async (stateResult) => {
        if (stateResult.type === "transition") recorded.push(stateResult.next);
      },
    });

    expect(result.session.machine.state).toBe("provider_selection");
    expect(ensureResumePreflightDashboardPortAvailable).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "get-sandbox",
      "resume-gpu-overrides",
      "skip-preflight",
      "record-preflight-skipped",
      "detect-gpu",
      "resolve-gpu-config",
      "validate-gpu-preflight",
      "assess-host",
      "reject-unsupported-runtime",
      "assert-cdi",
      "assert-bridge-dns",
      "resolve-gpu-config",
      "ensure-resume-preflight-port",
      "initial-gateway-reuse-state",
      "refresh-gateway-reuse",
      "gateway-lifecycle-support",
      "reconcile-gateway-gpu",
      "skip-gateway",
      "record-gateway-skipped",
      "record-gateway-complete",
    ]);
    expect(recorded).toEqual(["gateway", "provider_selection"]);
  });

  it("uses the strict runner for fresh init sessions", async () => {
    const order: string[] = [];
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
      context: context(),
      runtime: {
        session: async () => session,
        applyResult: async (stateResult) => {
          if (stateResult.type === "transition") {
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
      resume: false,
      recordStateResult: async () => {
        throw new Error("compatibility recorder should not run");
      },
    });

    expect(order).toEqual(["preflight", "gateway"]);
    expect(result.session.machine.state).toBe("provider_selection");
  });
});
