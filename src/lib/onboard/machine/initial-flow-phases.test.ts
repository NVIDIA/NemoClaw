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
