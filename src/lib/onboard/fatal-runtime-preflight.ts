// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectGpu, type GpuDetection } from "../inference/nim";
import { cliDisplayName } from "./branding";
import { assertDockerBridgeAndContainerDnsHealthy } from "./bridge-dns-preflight";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import {
  assertCdiNvidiaGpuSpecPresent,
  assessHost,
  type HostAssessment,
  planHostRemediation,
} from "./preflight";
import { printRemediationActions } from "./remediation";
import {
  resolveSandboxGpuConfig,
  type SandboxGpuConfig,
  type SandboxGpuFlag,
} from "./sandbox-gpu-mode";
import {
  resolveSandboxGpuFlagFromOptions,
  validateSandboxGpuPreflight,
} from "./sandbox-gpu-preflight";

export type FatalRuntimePreflightOptions = {
  sandboxGpu?: SandboxGpuFlag;
  sandboxGpuDevice?: string | null;
  gpu?: boolean;
  noGpu?: boolean;
  optedOutGpuPassthrough?: boolean;
  /** True only for the complete configuration replayed by rebuild. */
  authoritativeResumeConfig?: boolean;
};

export interface FatalRuntimePreflightContext {
  nonInteractive: boolean;
  exitProcess?: (code: number) => never;
  /** Alternate explicit marker for callers that pass a narrowed options object. */
  authoritativeResumeConfig?: boolean;
  /** Ambient environment seam used for proxy and GPU configuration tests. */
  env?: NodeJS.ProcessEnv;
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  sandboxGpuConfig: SandboxGpuConfig;
}

const exitProcessByDefault = (code: number): never => process.exit(code);

/** Reject runtimes that cannot support the OpenShell Docker-driver integration. */
export function rejectUnsupportedContainerRuntime(
  host: HostAssessment,
  exitProcess: (code: number) => never = exitProcessByDefault,
): void {
  if (isLinuxDockerDriverGatewayEnabled() && host.runtime === "podman") {
    console.error(`  ✗ ${cliDisplayName()} onboarding now uses OpenShell's Docker driver.`);
    console.error(`    Podman is not supported for this ${cliDisplayName()} integration path.`);
    console.error("    Switch to Docker Engine and rerun onboarding.");
    exitProcess(1);
  }
}

function sandboxGpuEnvironment(
  env: NodeJS.ProcessEnv,
  authoritativeResumeConfig: boolean,
): NodeJS.ProcessEnv {
  if (!authoritativeResumeConfig) return env;
  const sanitized = { ...env };
  delete sanitized.NEMOCLAW_SANDBOX_GPU;
  delete sanitized.NEMOCLAW_SANDBOX_GPU_DEVICE;
  return sanitized;
}

/** Run the non-mutating runtime gates shared by fresh, resume, and rebuild onboarding. */
export function runFatalOnboardRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): FatalRuntimePreflightResult {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const env = context.env ?? process.env;
  const authoritativeResumeConfig =
    options.authoritativeResumeConfig === true || context.authoritativeResumeConfig === true;
  const host = assessHost();
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    printRemediationActions(planHostRemediation(host));
    exitProcess(1);
  }

  rejectUnsupportedContainerRuntime(host, exitProcess);
  console.log("  ✓ Docker is running");
  warnIfHostProxyMissesLoopback(env);
  const gpu = detectGpu();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options, exitProcess),
    device: options.sandboxGpuDevice ?? null,
    env: sandboxGpuEnvironment(env, authoritativeResumeConfig),
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
  return { gpu, host, sandboxGpuConfig };
}
