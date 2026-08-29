// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { GatewayReuseState } from "../../state/gateway";
import { type GatewayOwner, isExternallySupervised } from "../gateway-ownership";
import { formatSandboxGpuPassthroughNote } from "../sandbox-gpu-notes";
import type { OnboardFlowContext } from "./flow-context";
import { UnexpectedOnboardFlowSliceStateError } from "./flow-slice-error";
import { runInitialOnboardFlowSequence } from "./flow-slices";
import { type GatewayStateOptions, handleGatewayState } from "./handlers/gateway";
import {
  handlePreflightState,
  type PreflightSandboxGpuConfig,
  type PreflightSandboxGpuFlag,
  type PreflightStateOptions,
} from "./handlers/preflight";
import {
  type OnboardPrerequisiteRepairEventRecorder,
  runOnboardPrerequisiteRepair,
} from "./prerequisite-repair";
import type { OnboardMachineRunnerResult, OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import type { OnboardMachineState } from "./types";

export type InitialOnboardFlowContext<
  Agent,
  Gpu,
  Config extends PreflightSandboxGpuConfig,
> = OnboardFlowContext<Agent, Gpu, Config> & {
  resumeHasResolvedGpuIntent: boolean;
  requestedGpuPassthrough: boolean;
};

type SpawnSync = typeof spawnSync;

export function getInitialGatewayReuseStateForOwner(
  owner: GatewayOwner,
  getManagedReuseState: () => GatewayReuseState,
): GatewayReuseState {
  return isExternallySupervised(owner) ? "missing" : getManagedReuseState();
}

export interface InitialOnboardFlowPhaseOptions<
  Context extends InitialOnboardFlowContext<Agent, Gpu, Config>,
  Agent,
  Gpu,
  SandboxEntry,
  Host,
  Config extends PreflightSandboxGpuConfig,
> {
  explicitSandboxGpuFlag: PreflightSandboxGpuFlag;
  sandboxGpuDevice?: string | null;
  gpuRequested: boolean;
  noGpu: boolean;
  allowDeferredN1xManagedVllm?: boolean;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  recordedGpuPassthroughBeforePreflight: boolean;
  /** Commit any provider lifecycle transition only after preflight admission. */
  commitSelectedAgentTransition?(): Promise<import("../../state/onboard-session").Session>;
  ensureResumePreflightDashboardPortAvailable(): void;
  preflightDeps: Omit<
    PreflightStateOptions<Gpu, SandboxEntry, Host, Config>["deps"],
    "assertGatewayReadiness"
  >;
  getInitialGatewayReuseState(): GatewayReuseState;
  assertGatewayReadiness(): Promise<void>;
  gatewayName: string;
  bindPolicyAuthority(
    gatewayName: string,
    session: import("../../state/onboard-session").Session | null,
  ): Promise<import("../../state/onboard-session").Session | null>;
  recreateSandbox(): boolean;
  requiresBindMounts?: boolean;
  gatewayDeps: GatewayStateOptions<Gpu>["deps"];
  note(message: string): void;
  spawnSync?: SpawnSync;
}

function emitPreflightGpuNote<Gpu, Config extends PreflightSandboxGpuConfig>(options: {
  gpu: Gpu | null;
  sandboxGpuConfig: Config;
  gpuPassthrough: boolean;
  resumeHasResolvedGpuIntent: boolean;
  requestedGpuPassthrough: boolean;
  recordedGpuPassthroughBeforePreflight: boolean;
  noGpu: boolean;
  platform: NodeJS.Platform;
  note(message: string): void;
  spawnSync: SpawnSync;
}): void {
  const gpuPlatform = (options.gpu as { platform?: string | null } | null)?.platform ?? null;
  if (options.gpuPassthrough) {
    options.note(
      formatSandboxGpuPassthroughNote({
        hostGpuPlatform: options.sandboxGpuConfig.hostGpuPlatform,
        resumeHasResolvedGpuIntent: options.resumeHasResolvedGpuIntent,
        recordedGpuPassthroughBeforePreflight: options.recordedGpuPassthroughBeforePreflight,
        requestedGpuPassthrough: options.requestedGpuPassthrough,
        sandboxGpuMode: options.sandboxGpuConfig.mode,
      }),
    );
    return;
  }
  if (gpuPlatform === "jetson") {
    options.note("  Sandbox GPU disabled by configuration on Jetson/Tegra.");
    return;
  }
  if (options.platform !== "linux" || options.noGpu) return;
  try {
    const lspci = options.spawnSync("lspci", { encoding: "utf-8", timeout: 5000 });
    if (lspci.status === 0 && /nvidia/i.test(lspci.stdout || "")) {
      const smi = options.spawnSync(
        "nvidia-smi",
        ["--query-gpu=name", "--format=csv,noheader,nounits"],
        { encoding: "utf-8", timeout: 5000 },
      );
      options.note(
        smi.status === 0 && smi.stdout?.trim()
          ? "  NVIDIA GPU detected with working drivers, but GPU passthrough was not enabled.\n  If Docker GPU support is needed, install nvidia-container-toolkit and run:\n  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
          : "  NVIDIA GPU hardware detected but nvidia-smi is not available.\n  Install NVIDIA drivers and the Container Toolkit for default GPU passthrough.",
      );
    }
  } catch {
    /* lspci not available - skip hint */
  }
}

export function createInitialOnboardFlowPhases<
  Context extends InitialOnboardFlowContext<Agent, Gpu, Config>,
  Agent,
  Gpu,
  SandboxEntry,
  Host,
  Config extends PreflightSandboxGpuConfig,
>(
  options: InitialOnboardFlowPhaseOptions<Context, Agent, Gpu, SandboxEntry, Host, Config>,
): readonly [OnboardSequencePhase<Context>, OnboardSequencePhase<Context>] {
  const preflightPhase: OnboardSequencePhase<Context> = {
    state: "preflight",
    async run(context) {
      const preflightResult = await handlePreflightState({
        resume: context.resume,
        session: context.session,
        recordedSandboxName: context.recordedSandboxName,
        requestedSandboxName: context.requestedSandboxName,
        explicitSandboxGpuFlag: options.explicitSandboxGpuFlag,
        sandboxGpuDevice: options.sandboxGpuDevice ?? null,
        gpuRequested: options.gpuRequested,
        noGpu: options.noGpu,
        allowDeferredN1xManagedVllm: options.allowDeferredN1xManagedVllm,
        env: options.env,
        deps: {
          ...options.preflightDeps,
          assertGatewayReadiness: options.assertGatewayReadiness,
        },
      });
      if (context.resume) options.ensureResumePreflightDashboardPortAvailable();
      const transitionedSession = options.commitSelectedAgentTransition
        ? await options.commitSelectedAgentTransition()
        : preflightResult.session;

      const preflightGpu = preflightResult.gpu ?? null;
      emitPreflightGpuNote({
        gpu: preflightGpu,
        sandboxGpuConfig: preflightResult.sandboxGpuConfig,
        gpuPassthrough: preflightResult.gpuPassthrough,
        resumeHasResolvedGpuIntent: preflightResult.resumeHasResolvedGpuIntent,
        requestedGpuPassthrough: preflightResult.requestedGpuPassthrough,
        recordedGpuPassthroughBeforePreflight: options.recordedGpuPassthroughBeforePreflight,
        noGpu: options.noGpu,
        platform: options.platform ?? process.platform,
        note: options.note,
        spawnSync: options.spawnSync ?? spawnSync,
      });
      return {
        context: {
          ...context,
          session: transitionedSession,
          gpu: preflightGpu,
          sandboxGpuConfig: preflightResult.sandboxGpuConfig,
          gpuPassthrough: preflightResult.gpuPassthrough,
          resumeHasResolvedGpuIntent: preflightResult.resumeHasResolvedGpuIntent,
          requestedGpuPassthrough: preflightResult.requestedGpuPassthrough,
        },
        result: preflightResult.stateResult,
      };
    },
  };

  const gatewayPhase: OnboardSequencePhase<Context> = {
    state: "gateway",
    async run(context) {
      // Resolve authority before the managed-only reuse helper can select a
      // gateway or mutate OPENSHELL_GATEWAY. External attachment revalidates
      // the same owner again at the effect edge.
      const owner = options.gatewayDeps.resolveGatewayOwner();
      await options.assertGatewayReadiness();
      const gatewayResult = await handleGatewayState({
        resume: context.resume,
        session: context.session,
        initialGatewayReuseState: getInitialGatewayReuseStateForOwner(
          owner,
          options.getInitialGatewayReuseState,
        ),
        gpu: context.gpu as Gpu,
        gpuPassthrough: context.gpuPassthrough,
        gatewayName: options.gatewayName,
        recordedSandboxName: context.recordedSandboxName,
        requestedSandboxName: context.requestedSandboxName,
        recreateSandbox: options.recreateSandbox(),
        requiresBindMounts: options.requiresBindMounts === true,
        deps: options.gatewayDeps,
      });
      const policySession = await options.bindPolicyAuthority(
        options.gatewayName,
        gatewayResult.session,
      );
      return {
        context: { ...context, session: policySession },
        result: gatewayResult.stateResult,
      };
    },
  };

  return [preflightPhase, gatewayPhase];
}

export async function runInitialOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordRepairEvent: OnboardPrerequisiteRepairEventRecorder;
}): Promise<OnboardMachineRunnerResult<Context>> {
  const durableEntry = await options.runtime.session();
  const state = durableEntry.machine.state;
  const resumeAheadStates: readonly OnboardMachineState[] = [
    "gateway",
    "provider_selection",
    "inference",
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
    "finalizing",
    "post_verify",
  ];
  const allowedStates: readonly OnboardMachineState[] = options.resume
    ? ["init", "preflight", ...resumeAheadStates]
    : ["init", "preflight", "gateway", "provider_selection"];
  if (!allowedStates.includes(state)) {
    throw new UnexpectedOnboardFlowSliceStateError(
      state,
      ["init", "preflight"],
      allowedStates.filter((candidate) => candidate !== "init" && candidate !== "preflight"),
    );
  }
  if (state === "init" || state === "preflight") {
    return runInitialOnboardFlowSequence(options);
  }

  const preflight = options.phases.find((phase) => phase.state === "preflight");
  const gateway = options.phases.find((phase) => phase.state === "gateway");
  if (!preflight || !gateway || options.phases.length !== 2) {
    throw new Error("Expected one preflight phase and one gateway phase");
  }
  const preflightRepair = await runOnboardPrerequisiteRepair({
    context: options.context,
    durableEntryState: state,
    phase: preflight,
    expectedFinalStates: ["gateway"],
    repair: "initial-flow-prerequisite",
    runtime: options.runtime,
    recordRepairEvent: options.recordRepairEvent,
  });
  if (state === "gateway") {
    return runInitialOnboardFlowSequence({
      context: preflightRepair.context,
      runtime: options.runtime,
      phases: options.phases,
    });
  }
  const gatewayRepair = await runOnboardPrerequisiteRepair({
    context: preflightRepair.context,
    durableEntryState: state,
    phase: gateway,
    expectedFinalStates: ["provider_selection"],
    repair: "initial-flow-prerequisite",
    runtime: options.runtime,
    recordRepairEvent: options.recordRepairEvent,
  });
  return { context: gatewayRepair.context, session: await options.runtime.session() };
}
