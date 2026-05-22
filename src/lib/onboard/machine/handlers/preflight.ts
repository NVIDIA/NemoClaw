// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";

export type PreflightSandboxGpuFlag = "enable" | "disable" | null;

export interface PreflightSandboxGpuOverrides {
  flag: PreflightSandboxGpuFlag;
  device: string | null;
}

export interface PreflightSandboxGpuConfig {
  sandboxGpuEnabled: boolean;
  mode: string;
  sandboxGpuDevice?: string | null;
  errors?: readonly string[];
}

export interface PreflightStateOptions<
  Gpu,
  SandboxEntry,
  Host,
  Config extends PreflightSandboxGpuConfig,
> {
  resume: boolean;
  session: Session | null;
  recordedSandboxName: string | null;
  requestedSandboxName: string | null;
  explicitSandboxGpuFlag: PreflightSandboxGpuFlag;
  sandboxGpuDevice?: string | null;
  gpuRequested: boolean;
  noGpu: boolean;
  env: NodeJS.ProcessEnv;
  deps: {
    getSandbox(name: string): SandboxEntry | null;
    getResumeSandboxGpuOverrides(
      sandbox: SandboxEntry | null,
      sessionGpuPassthrough: boolean | null | undefined,
    ): PreflightSandboxGpuOverrides;
    detectGpu(): Gpu;
    runPreflight(options: { optedOutGpuPassthrough?: boolean }): Promise<Gpu>;
    assessHost(): Host;
    assertCdiNvidiaGpuSpecPresent(host: Host, optedOutGpuPassthrough: boolean): void;
    resolveSandboxGpuConfig(
      gpu: Gpu,
      options: { flag: PreflightSandboxGpuFlag; device: string | null | undefined },
    ): Config;
    validateSandboxGpuPreflight(config: Config): void;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    startRecordedStep(stepName: string): Promise<void>;
    recordStepComplete(stepName: string): Promise<Session>;
    updateSession(mutator: (session: Session) => Session | void): Session;
  };
}

export interface PreflightStateResult<Gpu, Config extends PreflightSandboxGpuConfig> {
  gpu: Gpu;
  sandboxGpuConfig: Config;
  resumePreflight: boolean;
  resumeHasResolvedGpuIntent: boolean;
  requestedGpuPassthrough: boolean;
  gpuPassthrough: boolean;
  effectiveSandboxGpuFlag: PreflightSandboxGpuFlag;
  effectiveSandboxGpuDevice: string | null | undefined;
  session: Session | null;
}

function envHasSandboxGpuOverride(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_SANDBOX_GPU !== undefined || env.NEMOCLAW_SANDBOX_GPU_DEVICE !== undefined;
}

export async function handlePreflightState<
  Gpu,
  SandboxEntry,
  Host,
  Config extends PreflightSandboxGpuConfig,
>({
  resume,
  session,
  recordedSandboxName,
  requestedSandboxName,
  explicitSandboxGpuFlag,
  sandboxGpuDevice,
  gpuRequested,
  noGpu,
  env,
  deps,
}: PreflightStateOptions<Gpu, SandboxEntry, Host, Config>): Promise<PreflightStateResult<Gpu, Config>> {
  const resumeSandboxNameForGpu = recordedSandboxName || requestedSandboxName || null;
  const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
  const resumeHasResolvedGpuIntent =
    resumePreflight &&
    explicitSandboxGpuFlag === null &&
    sandboxGpuDevice == null &&
    !envHasSandboxGpuOverride(env);
  const resumedSandboxGpuOverrides = resumeHasResolvedGpuIntent
    ? deps.getResumeSandboxGpuOverrides(
        resumeSandboxNameForGpu ? deps.getSandbox(resumeSandboxNameForGpu) : null,
        session?.gpuPassthrough,
      )
    : { flag: null, device: null };
  const effectiveSandboxGpuFlag = explicitSandboxGpuFlag ?? resumedSandboxGpuOverrides.flag;
  const effectiveSandboxGpuDevice = sandboxGpuDevice ?? resumedSandboxGpuOverrides.device;

  let gpu: Gpu;
  if (resumePreflight) {
    deps.skippedStepMessage("preflight", "cached");
    gpu = deps.detectGpu();
    const resumeSandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
      flag: effectiveSandboxGpuFlag,
      device: effectiveSandboxGpuDevice,
    });
    deps.validateSandboxGpuPreflight(resumeSandboxGpuConfig);
    const resumeOptedOutGpuPassthrough =
      noGpu || (!gpuRequested && session?.gpuPassthrough === false) || !resumeSandboxGpuConfig.sandboxGpuEnabled;
    deps.assertCdiNvidiaGpuSpecPresent(deps.assessHost(), resumeOptedOutGpuPassthrough);
  } else {
    await deps.startRecordedStep("preflight");
    gpu = await deps.runPreflight({ optedOutGpuPassthrough: noGpu });
    session = await deps.recordStepComplete("preflight");
  }

  const sandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
    flag: effectiveSandboxGpuFlag,
    device: effectiveSandboxGpuDevice,
  });
  const gpuPassthrough = sandboxGpuConfig.sandboxGpuEnabled;
  if (session && session.gpuPassthrough !== gpuPassthrough) {
    session = deps.updateSession((current) => {
      current.gpuPassthrough = gpuPassthrough;
      return current;
    });
  }

  return {
    gpu,
    sandboxGpuConfig,
    resumePreflight,
    resumeHasResolvedGpuIntent,
    requestedGpuPassthrough: gpuRequested,
    gpuPassthrough,
    effectiveSandboxGpuFlag,
    effectiveSandboxGpuDevice,
    session,
  };
}
