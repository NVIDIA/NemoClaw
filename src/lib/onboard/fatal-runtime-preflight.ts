// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getBuildIdentity } from "../core/version";
import { detectGpu, type GpuDetection } from "../inference/nim";
import {
  createGatewayReadinessProjection,
  type GatewayReadinessProjection,
  refreshGatewayReadinessProjection,
} from "../readiness/gateway";
import {
  createProductionGatewayReadinessDependencies,
  type ProductionGatewayReadinessOptions,
} from "../readiness/gateway-production";
import { collectHostObservations, projectHostReadiness } from "../readiness/host";
import {
  evaluateOnboardGatewayReadinessAdmission,
  evaluateOnboardReadinessAdmission,
} from "../readiness/onboard-admission";
import { composeSystemReadinessReport } from "../readiness/system";
import type { SystemReadinessReport } from "../readiness/types";
import { assertDockerBridgeAndContainerDnsHealthy } from "./bridge-dns-preflight";
import {
  isLinuxDockerDriverGatewayEnabled,
  isPortableExperimentalProfile,
} from "./docker-driver-platform";
import { preparePortableExperimentalHost } from "./experimental/portable-host-preparation";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import { assessHost, type HostAssessment, planHostAdvisories } from "./preflight";
import {
  printCdiSpecUnavailableError,
  printDockerNotReachableError,
  printUnsupportedRuntimeError,
} from "./preflight-messages";
import { printRemediationActions } from "./remediation";
import { resolveSandboxGpuConfig, type SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  exitOnSandboxGpuConfigErrors,
  printJetsonNvidiaRuntimeUnavailableError,
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
  resuming?: boolean;
  allowStorageRemediation?: boolean;
  deferEffectfulChecks?: boolean;
  exitProcess?: (code: number) => never;
  assessHost?: typeof assessHost;
  /**
   * GPU detector used in both phases. Readiness collection passes an explicit
   * null WSL prover; the post-admission runtime phase calls it without that
   * override so the bounded Docker proof can run when needed.
   */
  detectGpu?: typeof detectGpu;
  preparePortableExperimentalHost?: typeof preparePortableExperimentalHost;
  warnIfHostProxyMissesLoopback?: typeof warnIfHostProxyMissesLoopback;
  assertDockerBridgeAndContainerDnsHealthy?: typeof assertDockerBridgeAndContainerDnsHealthy;
  validateSandboxGpuPreflight?: typeof validateSandboxGpuPreflight;
  now?: () => Date;
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  readinessReport: SystemReadinessReport;
  sandboxGpuConfig: SandboxGpuConfig;
}

export type ReadinessGatedRuntimePreflightContext = Omit<
  FatalRuntimePreflightContext,
  "allowStorageRemediation" | "deferEffectfulChecks"
> & {
  collectGatewayReadiness(): Promise<GatewayReadinessProjection>;
};

export interface ReadinessGatedRuntimePreflightResult extends FatalRuntimePreflightResult {
  gatewayReadiness: GatewayReadinessProjection;
}

const exitProcessByDefault = (code: number): never => process.exit(code);
const JETSON_INAPPLICABLE_CDI_ADVISORY_IDS = new Set([
  "warn_nvidia_cdi_refresh_unhealthy",
  "wsl_docker_desktop_gpu_compatibility",
  "generate_nvidia_cdi_spec",
  "refresh_nvidia_cdi_spec",
  "install_nvidia_container_toolkit",
]);

export interface OnboardHostReadinessOptions {
  explicitlyOptedOutGpuPassthrough: boolean;
  /** Preserve the outcome of a bounded WSL Docker Desktop GPU proof. */
  wslDockerDesktopGpuProofPassed?: boolean;
  resuming?: boolean;
  allowStorageRemediation?: boolean;
  allowPortableHostPreparation?: boolean;
  exitProcess?: (code: number) => never;
  observedAt?: string;
  now?: () => Date;
}

function printReadinessFailure(
  report: Pick<SystemReadinessReport, "findings">,
  findingIds: readonly string[],
  capabilityIds: readonly string[],
): void {
  const findings = new Map(report.findings.map((finding) => [finding.id, finding]));
  for (const findingId of findingIds) {
    const summary = findings.get(findingId)?.summary ?? findingId;
    console.error(`  ✗ ${summary}`);
  }
  if (capabilityIds.length > 0) {
    console.error(
      `  ✗ System readiness could not confirm required capabilities: ${capabilityIds.join(", ")}.`,
    );
  }
}

function printGatewayReadinessEvidence(gateway: GatewayReadinessProjection): void {
  const actionableEvidenceIds = new Set([
    "gateway.attachment.failure",
    "gateway.port.conflict",
    "gateway.probe.failure",
    "gateway.probe.stale",
  ]);
  for (const entry of gateway.evidence) {
    if (actionableEvidenceIds.has(entry.id)) console.error(`  ${entry.summary}`);
  }
}

/** Apply onboarding policy to one canonical system readiness report. */
export function assertOnboardSystemReadiness(
  readinessReport: SystemReadinessReport,
  host: HostAssessment,
  options: OnboardHostReadinessOptions,
): SystemReadinessReport {
  const exitProcess = options.exitProcess ?? exitProcessByDefault;
  const admission = evaluateOnboardReadinessAdmission(readinessReport, {
    explicitlyOptedOutGpuPassthrough: options.explicitlyOptedOutGpuPassthrough,
    allowUnsupportedRuntime:
      isPortableExperimentalProfile() || !isLinuxDockerDriverGatewayEnabled(),
    allowStorageRemediation: options.allowStorageRemediation === true,
    allowPortableHostPreparation: options.allowPortableHostPreparation,
  });
  if (admission.admitted) return readinessReport;
  const jetsonRuntimeMissing = admission.findingIds.includes("host.gpu.nvidia_runtime_missing");

  if (
    admission.findingIds.includes("host.docker.unavailable") ||
    admission.findingIds.includes("host.docker.daemon_unreachable")
  ) {
    printDockerNotReachableError();
  } else if (admission.findingIds.includes("host.docker.runtime_unsupported")) {
    printUnsupportedRuntimeError();
  } else if (
    admission.findingIds.includes("host.gpu.cdi_missing") ||
    admission.findingIds.includes("host.gpu.cdi_stale")
  ) {
    printCdiSpecUnavailableError();
  } else if (jetsonRuntimeMissing) {
    printJetsonNvidiaRuntimeUnavailableError();
  } else {
    printReadinessFailure(readinessReport, admission.findingIds, admission.capabilityIds);
  }
  const advisories = planHostAdvisories(host, { resuming: options.resuming });
  printRemediationActions(
    jetsonRuntimeMissing
      ? advisories.filter(({ id }) => !JETSON_INAPPLICABLE_CDI_ADVISORY_IDS.has(id))
      : advisories,
  );
  exitProcess(1);
  throw new Error("Onboarding continued after a blocking system readiness result.");
}

/** Fail closed on the canonical gateway projection before onboarding effects. */
export function assertOnboardGatewayReadiness(
  gateway: GatewayReadinessProjection,
  exitProcess: (code: number) => never = exitProcessByDefault,
): void {
  const admission = evaluateOnboardGatewayReadinessAdmission(gateway);
  if (admission.admitted) return;
  printReadinessFailure(gateway, admission.findingIds, admission.capabilityIds);
  printGatewayReadinessEvidence(gateway);
  exitProcess(1);
  throw new Error("Onboarding continued after an unsafe gateway readiness result.");
}

/** Collect and admit the production gateway projection before onboarding effects. */
export async function collectOnboardGatewayReadiness(
  options: ProductionGatewayReadinessOptions,
): Promise<GatewayReadinessProjection> {
  const gatewayReadiness = await createGatewayReadinessProjection(
    createProductionGatewayReadinessDependencies(options),
  );
  assertOnboardGatewayReadiness(gatewayReadiness);
  return gatewayReadiness;
}

function isManagedGatewayReadiness(gateway: GatewayReadinessProjection): boolean {
  return gateway.observations.some(
    ({ id, state, value }) =>
      id === "gateway.management.mode" && state === "present" && value === "nemoclaw-managed",
  );
}

function requiresRuntimeGpuProof(
  result: FatalRuntimePreflightResult,
  options: FatalRuntimePreflightOptions,
): boolean {
  return (
    result.host.isWsl &&
    result.host.runtime === "docker-desktop" &&
    result.host.dockerReachable &&
    result.host.hasNvidiaGpu &&
    result.gpu?.wslDockerDesktopGpuProofPassed !== true &&
    result.sandboxGpuConfig.mode !== "0" &&
    options.optedOutGpuPassthrough !== true
  );
}

function refreshOnboardHostReadiness(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
  allowStorageRemediation: boolean,
  runtimeGpu?: {
    value: GpuDetection | null;
    wslDockerDesktopGpuProofPassed?: boolean;
  },
): FatalRuntimePreflightResult {
  const now = context.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const host = (context.assessHost ?? assessHost)();
  const gpu = runtimeGpu
    ? runtimeGpu.value
    : (context.detectGpu ?? detectGpu)({ proveArm64WslDockerDesktopGpu: null });
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  const readinessReport = assertOnboardHostReadiness(host, gpu, {
    explicitlyOptedOutGpuPassthrough:
      sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    wslDockerDesktopGpuProofPassed: runtimeGpu?.wslDockerDesktopGpuProofPassed,
    resuming: context.resuming,
    allowStorageRemediation,
    exitProcess: context.exitProcess,
    observedAt,
    now,
  });
  return { gpu, host, readinessReport, sandboxGpuConfig };
}

/** Resolve the bounded WSL GPU proof only after canonical readiness admission. */
function resolveRuntimeGpuProof(
  result: FatalRuntimePreflightResult,
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): { result: FatalRuntimePreflightResult; proofRan: boolean } {
  if (!requiresRuntimeGpuProof(result, options)) return { result, proofRan: false };
  const gpu = (context.detectGpu ?? detectGpu)();
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  return {
    result: { ...result, gpu, sandboxGpuConfig },
    proofRan: true,
  };
}

/** Apply onboarding policy to one freshly collected host readiness report. */
export function assertOnboardHostReadiness(
  host: HostAssessment,
  gpu: GpuDetection | null,
  options: OnboardHostReadinessOptions,
): SystemReadinessReport {
  const now = options.now ?? (() => new Date());
  const observedAt = options.observedAt;
  const snapshot = collectHostObservations({
    assess: () => host,
    detectGpu: () => gpu,
    wslDockerDesktopGpuProofPassed: options.wslDockerDesktopGpuProofPassed,
    now: observedAt ? () => new Date(observedAt) : now,
  });
  const readinessReport = projectHostReadiness(snapshot, { ...getBuildIdentity(), now });
  return assertOnboardSystemReadiness(readinessReport, host, options);
}

/** Run runtime probes that may pull an image or start a short-lived container. */
export function runOnboardRuntimeEffectfulPreflightChecks(
  result: FatalRuntimePreflightResult,
  context: FatalRuntimePreflightContext,
): void {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  exitOnSandboxGpuConfigErrors(result.sandboxGpuConfig, exitProcess);
  console.log("  ✓ Docker is running");
  (context.warnIfHostProxyMissesLoopback ?? warnIfHostProxyMissesLoopback)();
  (context.validateSandboxGpuPreflight ?? validateSandboxGpuPreflight)(
    result.sandboxGpuConfig,
    {},
    exitProcess,
  );
  (context.assertDockerBridgeAndContainerDnsHealthy ?? assertDockerBridgeAndContainerDnsHealthy)(
    result.host,
    context.nonInteractive,
    exitProcess,
  );
  if (result.host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${result.host.runtime}`);
  }
  if (result.host.notes.includes("Running under WSL")) console.log("  ⓘ Running under WSL");
}

/** Revalidate gateway facts after host preparation and before runtime probe effects. */
export async function runReadinessGatedRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: ReadinessGatedRuntimePreflightContext,
): Promise<ReadinessGatedRuntimePreflightResult> {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const gatewayBeforePreparation = await context.collectGatewayReadiness();
  assertOnboardGatewayReadiness(gatewayBeforePreparation, exitProcess);
  runFatalOnboardRuntimePreflight(options, {
    ...context,
    allowStorageRemediation: isManagedGatewayReadiness(gatewayBeforePreparation),
    deferEffectfulChecks: true,
  });
  let gatewayReadiness = await context.collectGatewayReadiness();
  assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
  let managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
  // Gateway collection can be slow. Replace the earlier host observation so
  // the composite gate never stamps an old assessment with a fresh timestamp.
  let refreshedResult = refreshOnboardHostReadiness(options, context, managedGatewayReadiness);
  gatewayReadiness = refreshGatewayReadinessProjection(gatewayReadiness);
  assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
  managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
  let readinessReport = composeSystemReadinessReport(
    refreshedResult.readinessReport,
    gatewayReadiness,
  );
  assertOnboardSystemReadiness(readinessReport, refreshedResult.host, {
    explicitlyOptedOutGpuPassthrough:
      refreshedResult.sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    resuming: context.resuming,
    allowStorageRemediation: managedGatewayReadiness,
    exitProcess,
  });
  // The only GPU detection path that may pull or start a container is delayed
  // until both canonical host and gateway reports have admitted the run.
  const runtimeGpu = resolveRuntimeGpuProof(refreshedResult, options, {
    ...context,
    allowStorageRemediation: managedGatewayReadiness,
  });
  refreshedResult = runtimeGpu.result;
  if (runtimeGpu.proofRan) {
    // An explicit GPU request cannot fall back to CPU after a failed proof.
    // Reject that known configuration error before any later container probe.
    exitOnSandboxGpuConfigErrors(refreshedResult.sandboxGpuConfig, exitProcess);
    // The bounded proof may pull an image or start a short-lived container.
    // Replace both host and gateway observations again before later probes.
    gatewayReadiness = await context.collectGatewayReadiness();
    assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
    managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
    refreshedResult = refreshOnboardHostReadiness(options, context, managedGatewayReadiness, {
      value: runtimeGpu.result.gpu,
      // `detectGpu()` rejects a failed bounded proof by returning null. Keep
      // that negative outcome distinct from the observation-only phase's
      // intentionally unknown result. A normal trusted WSL GPU has no proof
      // marker and remains unknown because no bounded proof was necessary.
      wslDockerDesktopGpuProofPassed:
        runtimeGpu.result.gpu === null
          ? false
          : runtimeGpu.result.gpu.wslDockerDesktopGpuProofPassed,
    });
  }
  gatewayReadiness = refreshGatewayReadinessProjection(gatewayReadiness);
  assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
  managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
  readinessReport = composeSystemReadinessReport(refreshedResult.readinessReport, gatewayReadiness);
  assertOnboardSystemReadiness(readinessReport, refreshedResult.host, {
    explicitlyOptedOutGpuPassthrough:
      refreshedResult.sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    resuming: context.resuming,
    allowStorageRemediation: managedGatewayReadiness,
    exitProcess,
  });
  const gatedResult = {
    ...refreshedResult,
    readinessReport,
    gatewayReadiness,
  };
  runOnboardRuntimeEffectfulPreflightChecks(gatedResult, context);
  return gatedResult;
}

/** Prepare and run the runtime gates shared by fresh, resume, and rebuild onboarding. */
export function runFatalOnboardRuntimePreflight(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): FatalRuntimePreflightResult {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const assess = context.assessHost ?? assessHost;
  const detect = context.detectGpu ?? detectGpu;
  const preparePortable =
    context.preparePortableExperimentalHost ?? preparePortableExperimentalHost;
  const now = context.now ?? (() => new Date());
  let observedAt = now().toISOString();
  let host = assess();
  let gpu = detect({ proveArm64WslDockerDesktopGpu: null });
  let sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  let explicitlyOptedOutGpuPassthrough =
    sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true;

  if (isPortableExperimentalProfile()) {
    // Portable setup is an explicit remediation. Admit only its narrow,
    // pre-mutation exception set, apply it, then replace every observation
    // with a fresh canonical host report before continuing.
    assertOnboardHostReadiness(host, gpu, {
      explicitlyOptedOutGpuPassthrough,
      resuming: context.resuming,
      allowPortableHostPreparation: true,
      exitProcess,
      observedAt,
      now,
    });
    preparePortable(process.env);
    observedAt = now().toISOString();
    host = assess();
    gpu = detect({ proveArm64WslDockerDesktopGpu: null });
    sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
      flag: resolveSandboxGpuFlagFromOptions(options),
      device: options.sandboxGpuDevice ?? null,
    });
    explicitlyOptedOutGpuPassthrough =
      sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true;
  }
  const readinessReport = assertOnboardHostReadiness(host, gpu, {
    explicitlyOptedOutGpuPassthrough,
    resuming: context.resuming,
    allowStorageRemediation: context.allowStorageRemediation,
    exitProcess,
    observedAt,
    now,
  });
  let result = { gpu, host, readinessReport, sandboxGpuConfig };
  if (!context.deferEffectfulChecks) {
    const runtimeGpu = resolveRuntimeGpuProof(result, options, context);
    if (runtimeGpu.proofRan) {
      exitOnSandboxGpuConfigErrors(
        runtimeGpu.result.sandboxGpuConfig,
        context.exitProcess ?? exitProcessByDefault,
      );
    }
    result = runtimeGpu.proofRan
      ? refreshOnboardHostReadiness(options, context, context.allowStorageRemediation === true, {
          value: runtimeGpu.result.gpu,
          wslDockerDesktopGpuProofPassed:
            runtimeGpu.result.gpu === null
              ? false
              : runtimeGpu.result.gpu.wslDockerDesktopGpuProofPassed,
        })
      : runtimeGpu.result;
    runOnboardRuntimeEffectfulPreflightChecks(result, context);
  }
  return result;
}
