// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import { hasExplicitDeferredN1xOnboardingIntent } from "../../../readiness/onboard-admission";
import { isN1xOnboardingProviderKey } from "../../inference-providers/provider-selection-keys";
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
  allowDeferredN1xManagedVllm?: boolean;
  env: NodeJS.ProcessEnv;
  deps: {
    getSandbox(name: string): SandboxEntry | null;
    getResumeSandboxGpuOverrides(
      sandbox: SandboxEntry | null,
      sessionGpuPassthrough: boolean | null | undefined,
    ): PreflightSandboxGpuOverrides;
    /** Observe GPU state without running a container-backed proof. */
    detectGpuForReadiness(): Gpu;
    /** Resolve any runtime-backed GPU proof after readiness admission. */
    detectGpu(): Gpu;
    runPreflight(options: { optedOutGpuPassthrough?: boolean }): Promise<Gpu>;
    assessHost(): Host;
    providerNameToOptionKey(
      name: string | null | undefined,
      options?: { hasNimContainer?: boolean },
    ): string | null;
    assertOnboardHostReadiness(
      host: Host,
      gpu: Gpu,
      options: {
        explicitlyOptedOutGpuPassthrough: boolean;
        observedAt?: string;
        now?: () => Date;
        wslDockerDesktopGpuProofPassed?: boolean;
        allowDeferredN1xOnboarding?: boolean;
        resuming: true;
        presentAdvisories?: boolean;
      },
    ): void;
    /** Revalidate canonical gateway ownership before resume probe effects. */
    assertGatewayReadiness(): Promise<void>;
    now?: () => Date;
    /**
     * Resume backstop for #3508/#3630. Runs the selected provider's host,
     * bridge, and DNS gate so cached preflight cannot skip live runtime
     * readiness checks. Optional for back-compat with older callers.
     */
    assertRuntimeProviderHealthy?(host: Host, config: Config): void;
    resolveSandboxGpuConfig(
      gpu: Gpu,
      options: {
        flag: PreflightSandboxGpuFlag;
        device: string | null | undefined;
        env?: NodeJS.ProcessEnv;
      },
    ): Config;
    validateSandboxGpuPreflight(config: Config): void;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(
      state: "preflight",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
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

function resolvedWslDockerDesktopGpuProof(gpu: unknown): boolean | undefined {
  if (gpu === null) return false;
  if (!gpu || typeof gpu !== "object") return undefined;
  return (gpu as { wslDockerDesktopGpuProofPassed?: boolean }).wslDockerDesktopGpuProofPassed ===
    true
    ? true
    : undefined;
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
  allowDeferredN1xManagedVllm,
  env,
  deps,
}: PreflightStateOptions<Gpu, SandboxEntry, Host, Config>): Promise<
  PreflightStateResult<Gpu, Config>
> {
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
  const recordedProviderAllowsDeferredN1x = isN1xOnboardingProviderKey(
    deps.providerNameToOptionKey(session?.provider, {
      hasNimContainer: Boolean(session?.nimContainer),
    }),
  );
  // An explicit false is authoritative for rebuilds. Ordinary resume may use
  // the current installer choice or the provider already validated and recorded.
  const allowDeferredN1xOnboarding =
    allowDeferredN1xManagedVllm ??
    (recordedProviderAllowsDeferredN1x || hasExplicitDeferredN1xOnboardingIntent(env));

  let gpu: Gpu;
  if (resumePreflight) {
    deps.skippedStepMessage("preflight", "cached");
    await deps.recordStateSkipped("preflight", {
      reason: "resume",
      validation: "host-readiness",
    });
    const now = deps.now ?? (() => new Date());
    // Collect host facts, then require a live gateway result immediately
    // before any runtime-backed probe. A successful gateway collection is
    // younger than its reuse window, so the preceding host facts are current
    // at the effect edge too.
    let hostObservedAt = now().toISOString();
    let resumeHost = deps.assessHost();
    gpu = deps.detectGpuForReadiness();
    let resumeSandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
      flag: effectiveSandboxGpuFlag,
      device: effectiveSandboxGpuDevice,
      env,
    });
    await deps.assertGatewayReadiness();
    deps.assertOnboardHostReadiness(resumeHost, gpu, {
      explicitlyOptedOutGpuPassthrough: resumeSandboxGpuConfig.mode === "0",
      observedAt: hostObservedAt,
      now,
      allowDeferredN1xOnboarding,
      resuming: true,
    });
    // A full detector can run the bounded ARM64 WSL Docker GPU proof. Keep it
    // behind both live readiness gates, and skip it entirely for CPU-only
    // intent. Replace gateway and host facts after that effect before any
    // later runtime probe.
    if (resumeSandboxGpuConfig.mode !== "0") {
      gpu = deps.detectGpu();
      hostObservedAt = now().toISOString();
      resumeHost = deps.assessHost();
      resumeSandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
        flag: effectiveSandboxGpuFlag,
        device: effectiveSandboxGpuDevice,
        env,
      });
      await deps.assertGatewayReadiness();
      const wslDockerDesktopGpuProofPassed = resolvedWslDockerDesktopGpuProof(gpu);
      deps.assertOnboardHostReadiness(resumeHost, gpu, {
        explicitlyOptedOutGpuPassthrough: false,
        observedAt: hostObservedAt,
        now,
        ...(wslDockerDesktopGpuProofPassed === undefined ? {} : { wslDockerDesktopGpuProofPassed }),
        allowDeferredN1xOnboarding,
        resuming: true,
        presentAdvisories: false,
      });
    }
    // Resume backstop for #3508/#3630. Cached preflight does not capture
    // live runtime/DNS state, and a session written by an older NemoClaw
    // may have skipped the provider-owned checks.
    if (deps.assertRuntimeProviderHealthy) {
      deps.assertRuntimeProviderHealthy(resumeHost, resumeSandboxGpuConfig);
    } else {
      deps.validateSandboxGpuPreflight(resumeSandboxGpuConfig);
    }
  } else {
    await deps.startRecordedStep("preflight");
    gpu = await withPreflightTrace(() => deps.runPreflight({ optedOutGpuPassthrough: noGpu }));
    session = await deps.recordStepComplete("preflight");
  }

  const sandboxGpuConfig = deps.resolveSandboxGpuConfig(gpu, {
    flag: effectiveSandboxGpuFlag,
    device: effectiveSandboxGpuDevice,
    env,
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
