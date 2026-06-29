// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { GatewayReuseState } from "../../state/gateway";
import { formatSandboxGpuPassthroughNote } from "../sandbox-gpu-notes";
import type { OnboardFlowContext } from "./flow-context";
import { runInitialOnboardFlowSequence } from "./flow-slices";
import { type GatewayStateOptions, handleGatewayState } from "./handlers/gateway";
import {
  handlePreflightState,
  type PreflightSandboxGpuConfig,
  type PreflightSandboxGpuFlag,
  type PreflightStateOptions,
} from "./handlers/preflight";
import { runLiveOnboardFlowSlice } from "./live-flow-slice";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerResult, OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

export type InitialOnboardFlowContext<
  Agent,
  Gpu,
  Config extends PreflightSandboxGpuConfig,
> = OnboardFlowContext<Agent, Gpu, Config> & {
  resumeHasResolvedGpuIntent: boolean;
  requestedGpuPassthrough: boolean;
};

type SpawnSync = typeof spawnSync;

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
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  recordedGpuPassthroughBeforePreflight: boolean;
  ensureResumePreflightDashboardPortAvailable(): void;
  preflightDeps: PreflightStateOptions<Gpu, SandboxEntry, Host, Config>["deps"];
  getInitialGatewayReuseState(): GatewayReuseState;
  gatewayName: string;
  recreateSandbox(): boolean;
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
        env: options.env,
        deps: options.preflightDeps,
      });
      if (context.resume) options.ensureResumePreflightDashboardPortAvailable();

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
          session: preflightResult.session,
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
      const gatewayResult = await handleGatewayState({
        resume: context.resume,
        session: context.session,
        initialGatewayReuseState: options.getInitialGatewayReuseState(),
        gpu: context.gpu as Gpu,
        gpuPassthrough: context.gpuPassthrough,
        gatewayName: options.gatewayName,
        recordedSandboxName: context.recordedSandboxName,
        requestedSandboxName: context.requestedSandboxName,
        recreateSandbox: options.recreateSandbox(),
        deps: options.gatewayDeps,
      });
      return {
        context: { ...context, session: gatewayResult.session },
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
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
}): Promise<OnboardMachineRunnerResult<Context>> {
  // Compatibility bridge for live resume repair when durable machine snapshots
  // are already downstream of this slice even though preflight/gateway host
  // backstops must still re-run. Those ahead-state snapshots can come from
  // legacy/test step mutation that explicitly opts into `updateMachine === true`
  // or from repaired-resume replay of persisted sessions. This slice cannot
  // eliminate that source locally because the host backstop checks are still
  // modeled as imperative resume work rather than strict FSM recovery states.
  // The tolerated downstream family is every nonterminal state after the initial
  // slice: inference, sandbox, openclaw/agent_setup, policies, finalizing, and
  // post_verify. Phase tests cover ahead-state resume and terminal-state
  // rejection; remove this fallback once those repair/backstop checks are
  // modeled as strict FSM recovery states and legacy machine step mutation is
  // gone.
  return runLiveOnboardFlowSlice({
    context: options.context,
    runtime: options.runtime,
    phases: options.phases,
    runWhenState: ["init", "preflight"],
    compatibilityWhenState: options.resume
      ? [
          "init",
          "preflight",
          "gateway",
          "provider_selection",
          "inference",
          "sandbox",
          "openclaw",
          "agent_setup",
          "policies",
          "finalizing",
          "post_verify",
        ]
      : ["gateway", "provider_selection"],
    runSlice: runInitialOnboardFlowSequence,
    applyCompatibleResult: options.recordStateResult,
  });
}
