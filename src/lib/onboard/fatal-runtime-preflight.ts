// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectGpu, type GpuDetection } from "../inference/nim";
import { assertDockerBridgeAndContainerDnsHealthy } from "./bridge-dns-preflight";
import {
  type OpenShellComputePlan,
  resolveCurrentOpenShellComputePlan,
  usesManagedDockerGateway,
} from "./compute/plan";
import {
  assessNativePodman,
  type NativePodmanPreflightDeps,
  NativePodmanPreflightError,
  type NativePodmanPreflightReceipt,
} from "./compute/podman-preflight";
import {
  assertPodmanGpuAttachmentQualified,
  resolvePodmanGpuAttachment,
} from "./compute/podman/gpu-attachment";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import {
  assertCdiNvidiaGpuSpecPresent,
  assessHost,
  type HostAssessment,
  planHostRemediation,
} from "./preflight";
import { printDockerNotReachableError, printUnsupportedRuntimeError } from "./preflight-messages";
import { printRemediationActions } from "./remediation";
import { resolveSandboxGpuConfig, type SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  resolveSandboxGpuFlagFromOptions,
  validateSandboxGpuPreflight,
} from "./sandbox-gpu-preflight";
import type { OnboardOptions } from "./types";

export type FatalRuntimePreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "gpu" | "noGpu"
> & {
  optedOutGpuPassthrough?: boolean;
};

export interface FatalRuntimePreflightContext {
  nonInteractive: boolean;
  exitProcess?: (code: number) => never;
  computePlan?: OpenShellComputePlan;
  env?: NodeJS.ProcessEnv;
  nativePodmanDeps?: NativePodmanPreflightDeps;
  driverPreflightAdapters?: FatalRuntimePreflightDriverAdapterRegistry;
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  sandboxGpuConfig: SandboxGpuConfig;
  nativePodman: NativePodmanPreflightReceipt | null;
}

const exitProcessByDefault = (code: number): never => process.exit(code);
export interface FatalRuntimePreflightDriverAdapterInput {
  readonly options: FatalRuntimePreflightOptions;
  readonly nonInteractive: boolean;
  readonly exitProcess: (code: number) => never;
  readonly computePlan: OpenShellComputePlan;
  readonly env: NodeJS.ProcessEnv;
  readonly nativePodmanDeps?: NativePodmanPreflightDeps;
}

export interface FatalRuntimePreflightDriverReadinessInput {
  readonly host: HostAssessment;
  readonly computePlan: OpenShellComputePlan;
  readonly exitProcess: (code: number) => never;
  readonly env: NodeJS.ProcessEnv;
  readonly nativePodmanDeps?: NativePodmanPreflightDeps;
}

/**
 * Runtime-specific fatal checks are registered by driver identity. A new
 * driver must supply both entry points so it cannot silently inherit Docker
 * or Podman host probes.
 */
export interface FatalRuntimePreflightDriverAdapter {
  readonly driverName: string;
  readonly behavior: FatalRuntimePreflightDriverBehavior;
  assertReady(
    input: FatalRuntimePreflightDriverReadinessInput,
  ): NativePodmanPreflightReceipt | null;
  run(input: FatalRuntimePreflightDriverAdapterInput): FatalRuntimePreflightResult;
}

export interface FatalRuntimePreflightDriverBehavior {
  readonly checkContainerRuntimeResources: boolean;
  readonly checkDockerBridgeDns: boolean;
  readonly defaultSandboxGpuFlag: "disable" | null;
  readonly sandboxGpuUnsupportedMessage: string | null;
  readonly skipDockerProbe: boolean;
}

export type FatalRuntimePreflightDriverAdapterRegistry = Readonly<
  Record<string, FatalRuntimePreflightDriverAdapter>
>;

/** Reject runtimes that cannot support the OpenShell Docker-driver integration. */
export function rejectUnsupportedContainerRuntime(
  host: HostAssessment,
  exitProcess: (code: number) => never = exitProcessByDefault,
  computePlan: OpenShellComputePlan = resolveCurrentOpenShellComputePlan(),
): void {
  if (usesManagedDockerGateway(computePlan) && host.runtime === "podman") {
    printUnsupportedRuntimeError();
    exitProcess(1);
  }
}

function failNativePodman(error: unknown, exitProcess: (code: number) => never): never {
  const message =
    error instanceof NativePodmanPreflightError
      ? error.message
      : `Native Podman preflight failed: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`  ${message}`);
  exitProcess(1);
}

function assertDockerFamilyRuntimeReady(input: FatalRuntimePreflightDriverReadinessInput): null {
  rejectUnsupportedContainerRuntime(input.host, input.exitProcess, input.computePlan);
  return null;
}

function assertNativePodmanRuntimeReady(
  input: FatalRuntimePreflightDriverReadinessInput,
): NativePodmanPreflightReceipt {
  let receipt: NativePodmanPreflightReceipt;
  try {
    receipt = assessNativePodman(input.nativePodmanDeps);
  } catch (error) {
    return failNativePodman(error, input.exitProcess);
  }
  input.env.OPENSHELL_PODMAN_SOCKET = receipt.socketPath;
  return receipt;
}

function runDockerFamilyFatalRuntimePreflight(
  input: FatalRuntimePreflightDriverAdapterInput,
): FatalRuntimePreflightResult {
  const host = assessHost();
  assertDockerFamilyRuntimeReady({ ...input, host });
  if (!host.dockerReachable) {
    printDockerNotReachableError();
    printRemediationActions(planHostRemediation(host));
    input.exitProcess(1);
  }
  console.log("  ✓ Docker is running");
  warnIfHostProxyMissesLoopback();
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(input.options),
    device: input.options.sandboxGpuDevice ?? null,
  });
  const explicitlyOptedOutGpuPassthrough =
    input.options.optedOutGpuPassthrough === true || input.options.noGpu === true;
  assertCdiNvidiaGpuSpecPresent(
    host,
    explicitlyOptedOutGpuPassthrough,
    sandboxGpuConfig.hostGpuPlatform,
    input.exitProcess,
  );
  assertDockerBridgeAndContainerDnsHealthy(host, input.nonInteractive, input.exitProcess);
  validateSandboxGpuPreflight(sandboxGpuConfig, {}, input.exitProcess);
  if (host.runtime !== "unknown") console.log(`  ✓ Container runtime: ${host.runtime}`);
  if (host.notes.includes("Running under WSL")) console.log("  ⓘ Running under WSL");
  return { gpu, host, sandboxGpuConfig, nativePodman: null };
}

function runNativePodmanFatalRuntimePreflight(
  input: FatalRuntimePreflightDriverAdapterInput,
): FatalRuntimePreflightResult {
  const assessedHost = assessHost({ skipDockerProbe: true });
  const host = { ...assessedHost, runtime: "podman" as const, isUnsupportedRuntime: false };
  warnIfHostProxyMissesLoopback();
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(input.options),
    device: input.options.sandboxGpuDevice ?? null,
  });
  validateSandboxGpuPreflight(sandboxGpuConfig, {}, input.exitProcess);
  const nativePodman = assertNativePodmanRuntimeReady({ ...input, host: assessedHost });
  const gpuAttachment = resolvePodmanGpuAttachment(
    sandboxGpuConfig.sandboxGpuEnabled,
    sandboxGpuConfig.sandboxGpuDevice,
  );
  if (gpuAttachment) {
    try {
      assertPodmanGpuAttachmentQualified(nativePodman.cdiDevices, gpuAttachment);
    } catch (error) {
      return failNativePodman(error, input.exitProcess);
    }
  }
  console.log(
    `  ✓ Rootless Podman ${nativePodman.version} is reachable at ${nativePodman.socketPath}`,
  );
  console.log(`  ✓ Container runtime: podman (${nativePodman.networkBackend})`);
  if (gpuAttachment) console.log(`  ✓ Podman GPU CDI device: ${gpuAttachment.device}`);
  return { gpu, host, sandboxGpuConfig, nativePodman };
}

const dockerFatalRuntimePreflightAdapter: FatalRuntimePreflightDriverAdapter = {
  driverName: "docker",
  behavior: {
    checkContainerRuntimeResources: true,
    checkDockerBridgeDns: true,
    defaultSandboxGpuFlag: null,
    sandboxGpuUnsupportedMessage: null,
    skipDockerProbe: false,
  },
  assertReady: assertDockerFamilyRuntimeReady,
  run: runDockerFamilyFatalRuntimePreflight,
};

const kubernetesFatalRuntimePreflightAdapter: FatalRuntimePreflightDriverAdapter = {
  driverName: "kubernetes",
  behavior: dockerFatalRuntimePreflightAdapter.behavior,
  assertReady: assertDockerFamilyRuntimeReady,
  run: runDockerFamilyFatalRuntimePreflight,
};

export const CURRENT_FATAL_RUNTIME_PREFLIGHT_DRIVER_ADAPTERS = {
  docker: dockerFatalRuntimePreflightAdapter,
  kubernetes: kubernetesFatalRuntimePreflightAdapter,
  podman: {
    driverName: "podman",
    behavior: {
      checkContainerRuntimeResources: false,
      checkDockerBridgeDns: false,
      defaultSandboxGpuFlag: null,
      sandboxGpuUnsupportedMessage: null,
      skipDockerProbe: true,
    },
    assertReady: assertNativePodmanRuntimeReady,
    run: runNativePodmanFatalRuntimePreflight,
  },
} as const satisfies FatalRuntimePreflightDriverAdapterRegistry;

function resolveFatalRuntimePreflightDriverAdapter(
  computePlan: OpenShellComputePlan,
  adapters: FatalRuntimePreflightDriverAdapterRegistry,
): FatalRuntimePreflightDriverAdapter {
  const adapter = Object.hasOwn(adapters, computePlan.driverName)
    ? adapters[computePlan.driverName]
    : undefined;
  if (!adapter || adapter.driverName !== computePlan.driverName) {
    throw new Error(
      `OpenShell compute driver '${computePlan.driverName}' has no registered fatal runtime preflight adapter.`,
    );
  }
  return adapter;
}

export function resolveFatalRuntimePreflightDriverBehavior(
  computePlan: OpenShellComputePlan,
  adapters: FatalRuntimePreflightDriverAdapterRegistry = CURRENT_FATAL_RUNTIME_PREFLIGHT_DRIVER_ADAPTERS,
): FatalRuntimePreflightDriverBehavior {
  return resolveFatalRuntimePreflightDriverAdapter(computePlan, adapters).behavior;
}

export function assertSelectedContainerRuntimeReady(
  host: HostAssessment,
  computePlan: OpenShellComputePlan,
  options: {
    exitProcess?: (code: number) => never;
    env?: NodeJS.ProcessEnv;
    nativePodmanDeps?: NativePodmanPreflightDeps;
    driverPreflightAdapters?: FatalRuntimePreflightDriverAdapterRegistry;
  } = {},
): NativePodmanPreflightReceipt | null {
  const exitProcess = options.exitProcess ?? exitProcessByDefault;
  const env = options.env ?? process.env;
  const adapter = resolveFatalRuntimePreflightDriverAdapter(
    computePlan,
    options.driverPreflightAdapters ?? CURRENT_FATAL_RUNTIME_PREFLIGHT_DRIVER_ADAPTERS,
  );
  return adapter.assertReady({
    host,
    computePlan,
    exitProcess,
    env,
    nativePodmanDeps: options.nativePodmanDeps,
  });
}

/** Run the non-mutating runtime gates shared by fresh, resume, and rebuild onboarding. */
export function runFatalOnboardRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): FatalRuntimePreflightResult {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const computePlan = context.computePlan ?? resolveCurrentOpenShellComputePlan();
  const adapter = resolveFatalRuntimePreflightDriverAdapter(
    computePlan,
    context.driverPreflightAdapters ?? CURRENT_FATAL_RUNTIME_PREFLIGHT_DRIVER_ADAPTERS,
  );
  return adapter.run({
    options,
    nonInteractive: context.nonInteractive,
    exitProcess,
    computePlan,
    env: context.env ?? process.env,
    nativePodmanDeps: context.nativePodmanDeps,
  });
}
