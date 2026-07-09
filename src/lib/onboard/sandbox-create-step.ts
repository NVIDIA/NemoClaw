// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type {
  StreamSandboxCreateOptions,
  StreamSandboxCreateResult,
  streamSandboxCreate,
} from "../sandbox/create-stream";
import { getReadyCheckOutputPatternsForAgent } from "../sandbox/create-stream-ready-gate";
import type {
  createDockerGpuSandboxCreatePatch,
  DockerGpuSandboxCreatePatch,
} from "./docker-gpu-sandbox-create";
import type {
  prepareSandboxCreateLaunchWithPrebuild,
  SandboxCreateLaunchWithPrebuild,
  SandboxCreateLaunchWithPrebuildInput,
} from "./sandbox-create-launch";

type LaunchInput = SandboxCreateLaunchWithPrebuildInput;
type GpuPatchDeps = Parameters<typeof createDockerGpuSandboxCreatePatch>[0]["deps"];

export type SandboxCreateStepContext = {
  agent: LaunchInput["agent"];
  observabilityEnabled: boolean;
  chatUiUrl: string;
  createArgs: LaunchInput["createArgs"];
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  extraPlaceholderKeys: LaunchInput["extraPlaceholderKeys"];
  getDashboardForwardPort: LaunchInput["getDashboardForwardPort"];
  hermesDashboardState: LaunchInput["hermesDashboardState"];
  manageDashboard: boolean;
  openshellShellCommand: LaunchInput["openshellShellCommand"];
  openshellArgv?: LaunchInput["openshellArgv"];
  prebuild: LaunchInput["prebuild"];
  useDockerGpuPatch: boolean;
  gpuDevice: string | null | undefined;
  gpuBackend: "jetson" | "generic";
  timeoutSecs: number;
};

export type SandboxCreateStepDeps = {
  prepareCreateLaunch: typeof prepareSandboxCreateLaunchWithPrebuild;
  createDockerGpuPatch: typeof createDockerGpuSandboxCreatePatch;
  streamCreate: typeof streamSandboxCreate;
  isSandboxReady(output: string, sandboxName: string): boolean;
  isTerminalAgent(agent: AgentDefinition | null | undefined): boolean;
  addTraceEvent: NonNullable<StreamSandboxCreateOptions["traceEvent"]>;
  runOpenshell: GpuPatchDeps["runOpenshell"];
  runCaptureOpenshell: NonNullable<GpuPatchDeps["runCaptureOpenshell"]>;
  sleepSeconds: GpuPatchDeps["sleep"];
};

export type SandboxCreateStepResult = {
  createResult: StreamSandboxCreateResult;
  prebuild: SandboxCreateLaunchWithPrebuild["prebuild"];
  effectiveDashboardPort: string;
  dockerGpuCreatePatch: DockerGpuSandboxCreatePatch;
};

/**
 * Resolve the BuildKit prebuild handoff into the launch command, provision the
 * Docker-GPU create patch, and stream the sandbox create. Returns the create
 * result plus the handles the caller needs downstream (prebuild identity, the
 * dashboard port, and the GPU patch for its ready/verify hooks). Build-context
 * and exit-listener cleanup stay with the caller that armed them.
 */
export async function runSandboxCreateStep(
  context: SandboxCreateStepContext,
  deps: SandboxCreateStepDeps,
): Promise<SandboxCreateStepResult> {
  const {
    createCommand,
    createArgv,
    effectiveDashboardPort,
    prebuild,
    sandboxEnv,
    sandboxStartupCommand,
  } = await deps.prepareCreateLaunch({
    agent: context.agent,
    observabilityEnabled: context.observabilityEnabled,
    chatUiUrl: context.chatUiUrl,
    createArgs: context.createArgs,
    sandboxName: context.sandboxName,
    env: context.env,
    extraPlaceholderKeys: context.extraPlaceholderKeys,
    getDashboardForwardPort: context.getDashboardForwardPort,
    hermesDashboardState: context.hermesDashboardState,
    manageDashboard: context.manageDashboard,
    openshellShellCommand: context.openshellShellCommand,
    openshellArgv: context.openshellArgv,
    prebuild: context.prebuild,
  });
  const dockerGpuCreatePatch = deps.createDockerGpuPatch({
    enabled: context.useDockerGpuPatch,
    sandboxName: context.sandboxName,
    gpuDevice: context.gpuDevice,
    openshellSandboxCommand: sandboxStartupCommand,
    timeoutSecs: context.timeoutSecs,
    backend: context.gpuBackend,
    deps: {
      runOpenshell: deps.runOpenshell,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      sleep: deps.sleepSeconds,
    },
  });
  const [createExecutable, ...createExecutableArgs] = createArgv;
  const createResult = await deps.streamCreate(
    createExecutable ?? createCommand,
    createExecutableArgs,
    sandboxEnv,
    {
      readyCheck: () => {
        const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
        return deps.isSandboxReady(list, context.sandboxName);
      },
      onPoll: () => dockerGpuCreatePatch.maybeApplyDuringCreate(),
      readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent(
        deps.isTerminalAgent(context.agent),
        sandboxEnv,
      ),
      failureCheck: dockerGpuCreatePatch.createFailureMessage,
      traceEvent: deps.addTraceEvent,
    },
  );
  return { createResult, prebuild, effectiveDashboardPort, dockerGpuCreatePatch };
}
