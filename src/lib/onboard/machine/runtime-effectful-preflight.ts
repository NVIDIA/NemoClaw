// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertDockerBridgeAndContainerDnsHealthy,
  assertHostDnsHealthy,
} from "../bridge-dns-preflight";
import { isPortableExperimentalProfile } from "../docker-driver-platform";
import {
  BUSYBOX_PROBE_IMAGE,
  dnsProbeName,
  type DockerBridgeContainerStartProbeResult,
  type DnsProbeResult,
  type HostAssessment,
  isFatalContainerDnsProbeFailure,
  probeContainerDns,
  probeDockerBridgeContainerStart,
} from "../preflight";
import type {
  RuntimeProviderBundle,
  RuntimeProviderDoctorCheck,
  RuntimeProviderGatewayHostRuntime,
} from "../runtime-provider/contract";
import { resolveConfiguredRuntimeProvider } from "../runtime-provider/selection";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import { validateSandboxGpuPreflight } from "../sandbox-gpu-preflight";

const RUNTIME_NETWORK_PROBE_TIMEOUT_MS = 20_000;

type ExitProcess = (code: number) => never;
type RuntimeProviderResolver = (
  platform?: NodeJS.Platform,
  architecture?: NodeJS.Architecture,
  environment?: NodeJS.ProcessEnv,
) => RuntimeProviderBundle;

export interface RuntimeEffectfulPreflightDependencies {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  isPortableProfile?: typeof isPortableExperimentalProfile;
  resolveProvider?: RuntimeProviderResolver;
  assertPortableRuntimeHealthy?: typeof assertDockerBridgeAndContainerDnsHealthy;
  validatePortableSandboxGpuPreflight?: typeof validateSandboxGpuPreflight;
}

export function bindConfiguredRuntimeProviderHealth(
  isNonInteractive: () => boolean,
): (host: HostAssessment, sandboxGpuConfig: SandboxGpuConfig) => void {
  return (host, sandboxGpuConfig) =>
    assertConfiguredRuntimeProviderHealthy(host, sandboxGpuConfig, isNonInteractive());
}

function printProbeDetails(details: string | undefined, output: typeof console.warn): void {
  if (!details) return;
  for (const line of details.split("\n").slice(-4)) {
    if (line.trim()) output(`    ${line.trim()}`);
  }
}

function presentProviderDoctor(check: RuntimeProviderDoctorCheck, exitProcess: ExitProcess): void {
  if (check.status === "fail") {
    console.error(`  ✗ ${check.label}: ${check.detail}`);
    if (check.hint) console.error(`    ${check.hint}`);
    exitProcess(1);
  }
  if (check.status === "warn") {
    console.warn(`  ⚠ ${check.label}: ${check.detail}`);
    if (check.hint) console.warn(`    ${check.hint}`);
    return;
  }
  const marker = check.status === "ok" ? "✓" : "ⓘ";
  console.log(`  ${marker} ${check.label}: ${check.detail}`);
}

function probeProviderBridge(
  runtime: RuntimeProviderGatewayHostRuntime,
  cached: ReturnType<RuntimeProviderGatewayHostRuntime["network"]["ensureProbeImageCached"]>,
): DockerBridgeContainerStartProbeResult {
  return probeDockerBridgeContainerStart({
    command: ["run", "--rm", "--pull=missing", "--network", "bridge", BUSYBOX_PROBE_IMAGE, "true"],
    ensureImageCachedOverride: cached,
    runProbeImpl: (command, options) =>
      runtime.network.run(command, options?.timeout ?? RUNTIME_NETWORK_PROBE_TIMEOUT_MS),
  });
}

function probeProviderDns(
  runtime: RuntimeProviderGatewayHostRuntime,
  cached: ReturnType<RuntimeProviderGatewayHostRuntime["network"]["ensureProbeImageCached"]>,
): DnsProbeResult {
  const probeName = dnsProbeName();
  return probeContainerDns({
    probeName,
    command: [
      "run",
      "--rm",
      "--pull=missing",
      "--network",
      "bridge",
      BUSYBOX_PROBE_IMAGE,
      "nslookup",
      probeName,
    ],
    ensureImageCachedOverride: cached,
    runProbeImpl: (command, options) =>
      runtime.network.run(command, options?.timeout ?? RUNTIME_NETWORK_PROBE_TIMEOUT_MS),
  });
}

function assertProviderNetworkHealthy(
  providerDisplayName: string,
  runtime: RuntimeProviderGatewayHostRuntime,
  host: HostAssessment,
  nonInteractive: boolean,
  exitProcess: ExitProcess,
): void {
  const cached = runtime.network.ensureProbeImageCached(BUSYBOX_PROBE_IMAGE);
  const bridgeStart = probeProviderBridge(runtime, cached);
  if (bridgeStart.ok) {
    console.log(`  ✓ ${providerDisplayName} can start bridge containers`);
  } else if (
    bridgeStart.reason === "veth_unsupported" ||
    bridgeStart.reason === "timeout" ||
    bridgeStart.reason === "killed" ||
    bridgeStart.reason === "docker_daemon_unreachable"
  ) {
    console.error(`  ✗ ${providerDisplayName} could not start a bridge-network test container.`);
    printProbeDetails(bridgeStart.details, console.error);
    console.error(`    Verify ${providerDisplayName} bridge networking and retry onboarding.`);
    exitProcess(1);
  } else {
    console.warn(
      `  ⚠ ${providerDisplayName} bridge container start probe inconclusive (reason: ${bridgeStart.reason ?? "unknown"}).`,
    );
    printProbeDetails(bridgeStart.details, console.warn);
    console.warn("    Continuing to DNS probe for more specific diagnosis.");
  }

  assertHostDnsHealthy(host, { nonInteractive, exit: exitProcess });

  const dns = probeProviderDns(runtime, cached);
  if (dns.ok) {
    console.log(`  ✓ ${providerDisplayName} container DNS resolution works`);
    return;
  }
  if (!isFatalContainerDnsProbeFailure(dns)) {
    console.warn(
      `  ⚠ ${providerDisplayName} container DNS probe inconclusive (reason: ${dns.reason ?? "unknown"}).`,
    );
    printProbeDetails(dns.details, console.warn);
    console.warn("    Proceeding; a later sandbox operation will surface a definitive failure.");
    return;
  }

  console.error(`  ✗ ${providerDisplayName} container DNS resolution failed.`);
  printProbeDetails(dns.details, console.error);
  console.error(
    `    Verify ${providerDisplayName} bridge networking and container DNS, then retry onboarding.`,
  );
  exitProcess(1);
}

/**
 * Resolve the configured native provider once, then execute its owned host and
 * network preflight surfaces. The portable compatibility profile deliberately
 * retains its existing Docker-specific preflight path.
 */
export function assertConfiguredRuntimeProviderHealthy(
  host: HostAssessment,
  sandboxGpuConfig: SandboxGpuConfig,
  nonInteractive = false,
  exitProcess: ExitProcess = (code) => process.exit(code),
  dependencies: RuntimeEffectfulPreflightDependencies = {},
): void {
  const environment = dependencies.environment ?? process.env;
  const isPortableProfile = dependencies.isPortableProfile ?? isPortableExperimentalProfile;
  if (isPortableProfile(environment)) {
    const validatePortableSandboxGpuPreflight =
      dependencies.validatePortableSandboxGpuPreflight ?? validateSandboxGpuPreflight;
    validatePortableSandboxGpuPreflight(sandboxGpuConfig, {}, exitProcess);
    const assertPortableRuntimeHealthy =
      dependencies.assertPortableRuntimeHealthy ?? assertDockerBridgeAndContainerDnsHealthy;
    assertPortableRuntimeHealthy(host, nonInteractive, exitProcess);
    return;
  }

  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const resolveProvider = dependencies.resolveProvider ?? resolveConfiguredRuntimeProvider;
  const provider = resolveProvider(platform, architecture, environment);
  presentProviderDoctor(provider.preflightDoctor.inspectHost(), exitProcess);
  provider.preflightDoctor.validateSandboxGpu(sandboxGpuConfig, exitProcess);
  const runtime = provider.gateway.prepareHostRuntime({
    environment,
    platform,
  });
  assertProviderNetworkHealthy(
    provider.identity.displayName,
    runtime,
    host,
    nonInteractive,
    exitProcess,
  );
}
