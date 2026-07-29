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
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  sandboxGpuConfig: SandboxGpuConfig;
  nativePodman: NativePodmanPreflightReceipt | null;
}

const exitProcessByDefault = (code: number): never => process.exit(code);

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

export function assertSelectedContainerRuntimeReady(
  host: HostAssessment,
  computePlan: OpenShellComputePlan,
  options: {
    exitProcess?: (code: number) => never;
    env?: NodeJS.ProcessEnv;
    nativePodmanDeps?: NativePodmanPreflightDeps;
  } = {},
): NativePodmanPreflightReceipt | null {
  const exitProcess = options.exitProcess ?? exitProcessByDefault;
  if (computePlan.driverName !== "podman") {
    rejectUnsupportedContainerRuntime(host, exitProcess, computePlan);
    return null;
  }

  let receipt: NativePodmanPreflightReceipt;
  try {
    receipt = assessNativePodman(options.nativePodmanDeps);
  } catch (error) {
    return failNativePodman(error, exitProcess);
  }
  const env = options.env ?? process.env;
  env.OPENSHELL_PODMAN_SOCKET = receipt.socketPath;
  return receipt;
}

/** Run the non-mutating runtime gates shared by fresh, resume, and rebuild onboarding. */
export function runFatalOnboardRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): FatalRuntimePreflightResult {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const computePlan = context.computePlan ?? resolveCurrentOpenShellComputePlan();
  const assessedHost = assessHost({ skipDockerProbe: computePlan.driverName === "podman" });
  const nativePodman = assertSelectedContainerRuntimeReady(assessedHost, computePlan, {
    exitProcess,
    env: context.env,
    nativePodmanDeps: context.nativePodmanDeps,
  });
  const host = nativePodman
    ? { ...assessedHost, runtime: "podman" as const, isUnsupportedRuntime: false }
    : assessedHost;
  if (nativePodman) {
    warnIfHostProxyMissesLoopback();
    const gpu = detectGpu();
    if (options.gpu === true || options.sandboxGpu === "enable") {
      console.error(
        "  Native Podman support currently covers CPU sandboxes with hosted inference; GPU passthrough is not yet supported.",
      );
      exitProcess(1);
    }
    const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
      flag: "disable",
      device: null,
    });
    validateSandboxGpuPreflight(sandboxGpuConfig, {}, exitProcess);
    console.log(
      `  ✓ Rootless Podman ${nativePodman.version} is reachable at ${nativePodman.socketPath}`,
    );
    console.log(`  ✓ Container runtime: podman (${nativePodman.networkBackend})`);
    return { gpu, host, sandboxGpuConfig, nativePodman };
  }
  if (!host.dockerReachable) {
    printDockerNotReachableError();
    printRemediationActions(planHostRemediation(host));
    exitProcess(1);
  }
  console.log("  ✓ Docker is running");
  warnIfHostProxyMissesLoopback();
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  const explicitlyOptedOutGpuPassthrough =
    options.optedOutGpuPassthrough === true || options.noGpu === true;
  assertCdiNvidiaGpuSpecPresent(
    host,
    explicitlyOptedOutGpuPassthrough,
    sandboxGpuConfig.hostGpuPlatform,
    exitProcess,
  );
  assertDockerBridgeAndContainerDnsHealthy(host, context.nonInteractive, exitProcess);
  validateSandboxGpuPreflight(sandboxGpuConfig, {}, exitProcess);
  if (host.runtime !== "unknown") console.log(`  ✓ Container runtime: ${host.runtime}`);
  if (host.notes.includes("Running under WSL")) console.log("  ⓘ Running under WSL");
  return { gpu, host, sandboxGpuConfig, nativePodman: null };
}
