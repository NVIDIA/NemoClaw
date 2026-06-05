// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import { withPreflightTrace } from "../../tracing";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

export type PreflightSandboxGpuFlag = "enable" | "disable" | null;

export interface PreflightSandboxGpuOverrides {
  flag: PreflightSandboxGpuFlag;
  device: string | null;
}

export interface PreflightSandboxGpuConfig {
  sandboxGpuEnabled: boolean;
  mode: string;
  hostGpuPlatform?: string | null;
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
    assertCdiNvidiaGpuSpecPresent(
      host: Host,
      optedOutGpuPassthrough: boolean,
      hostGpuPlatform?: string | null,
    ): void;
    /**
     * Resume backstop for #3508/#3630. Runs the same bridge+DNS fatal
     * gate that `preflight()` does, so a cached preflight step cannot
     * skip the new fatal checks for hosts where Docker bridge networking
     * or container DNS is broken. Optional for back-compat with callers
     * that haven't been updated yet.
     */
    assertDockerBridgeAndContainerDnsHealthy?(host: Host): void;
    /**
     * Resume backstop for unsupported container runtimes (e.g. Podman
     * with the Linux Docker-driver gateway). Must run before the bridge/
     * DNS backstop above so Podman hosts see the unsupported-runtime
     * message instead of Docker-specific diagnostics.
     */
    rejectUnsupportedContainerRuntime?(host: Host): void;
    resolveSandboxGpuConfig(
      gpu: Gpu,
      options: { flag: PreflightSandboxGpuFlag; device: string | null | undefined },
    ): Config;
    validateSandboxGpuPreflight(config: Config): void;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(state: "preflight", metadata?: Record<string, unknown> | null): Promise<Session>;
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
  stateResult: OnboardStateTransitionResult;
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
    await deps.recordStateSkipped("preflight", { reason: "resume", validation: "gpu-cdi" });
    gpu = deps.detectGpu();
    const resumeSandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
      flag: effectiveSandboxGpuFlag,
      device: effectiveSandboxGpuDevice,
    });
    deps.validateSandboxGpuPreflight(resumeSandboxGpuConfig);
    const resumeOptedOutGpuPassthrough =
      noGpu || (!gpuRequested && session?.gpuPassthrough === false) || !resumeSandboxGpuConfig.sandboxGpuEnabled;
    const resumeHost = deps.assessHost();
    // Reject unsupported runtimes (Podman) BEFORE the CDI GPU-spec
    // backstop and the Docker-specific bridge/DNS probes so Podman
    // hosts always hit the unsupported-runtime message (#3630
    // CodeRabbit).
    deps.rejectUnsupportedContainerRuntime?.(resumeHost);
    deps.assertCdiNvidiaGpuSpecPresent(
      resumeHost,
      resumeOptedOutGpuPassthrough,
      resumeSandboxGpuConfig.hostGpuPlatform,
    );
    // Resume backstop for #3508/#3630. Cached preflight does not capture
    // host Docker/DNS state, and a session written by an older NemoClaw
    // may have skipped the new bridge/DNS fatal checks.
    deps.assertDockerBridgeAndContainerDnsHealthy?.(resumeHost);
  } else {
    await deps.startRecordedStep("preflight");
    gpu = await withPreflightTrace(() => deps.runPreflight({ optedOutGpuPassthrough: noGpu }));
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
    stateResult: advanceTo("gateway", {
      metadata: { state: "preflight", gpuPassthrough },
    }),
  };
}
