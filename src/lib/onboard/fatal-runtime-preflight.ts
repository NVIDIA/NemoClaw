// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getBuildIdentity } from "../core/version";
import { detectGpu, type GpuDetection } from "../inference/nim";
import {
  collectGatewayObservations,
  type GatewayObservationSnapshot,
  type GatewayReadinessProjection,
  projectGatewayReadiness,
} from "../readiness/gateway";
import {
  createProductionGatewayReadinessDependencies,
  type ProductionGatewayReadinessOptions,
} from "../readiness/gateway-production";
import {
  collectHostObservations,
  type HostObservationSnapshot,
  projectHostReadiness,
} from "../readiness/host";
import {
  evaluateOnboardGatewayReadinessAdmission,
  evaluateOnboardReadinessAdmission,
} from "../readiness/onboard-admission";
import { composeSystemReadinessReport } from "../readiness/system";
import type { SystemReadinessReport } from "../readiness/types";
import {
  isLinuxDockerDriverGatewayEnabled,
  isPortableExperimentalProfile,
} from "./docker-driver-platform";
import { configuredRuntimeProviderOwnsHostReadiness } from "./docker-driver-gateway-env";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import { assertConfiguredRuntimeProviderHealthy } from "./machine/runtime-effectful-preflight";
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
import { MANAGED_VLLM_PROVIDER_KEY } from "./vllm-menu";

export type FatalRuntimePreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "gpu" | "noGpu"
> & {
  /** Explicit false prevents ambient provider intent from crossing a rebuild boundary. */
  allowDeferredN1xManagedVllm?: boolean;
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
  warnIfHostProxyMissesLoopback?: typeof warnIfHostProxyMissesLoopback;
  assertRuntimeProviderHealthy?: typeof assertConfiguredRuntimeProviderHealthy;
  validateSandboxGpuPreflight?: typeof validateSandboxGpuPreflight;
  now?: () => Date;
}

export interface FatalRuntimePreflightResult {
  gpu: GpuDetection | null;
  host: HostAssessment;
  readinessReport: SystemReadinessReport;
  sandboxGpuConfig: SandboxGpuConfig;
  // Which trust-gate check rejected the newest GPU detection, so preflight can
  // name the failed check instead of the bare "no GPU detected" (#9000).
  // Absent when detection found a GPU or did not reject an nvidia-smi report.
  gpuTrustGateRejection?: string;
}

export type ReadinessGatedRuntimePreflightContext = Omit<
  FatalRuntimePreflightContext,
  "allowStorageRemediation" | "deferEffectfulChecks"
> & {
  collectGatewayReadiness(): Promise<CollectedGatewayReadiness>;
};

export interface CollectedGatewayReadiness {
  projection: GatewayReadinessProjection;
  snapshot: GatewayObservationSnapshot;
}

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
  allowDeferredN1xManagedVllm?: boolean;
  /** Print warning-severity host advisories before returning an admitted report. */
  presentAdvisories?: boolean;
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
  const portable = isPortableExperimentalProfile();
  const managedLocalGatewayEnabled =
    host.platform === "linux" && isLinuxDockerDriverGatewayEnabled("linux");
  const selectedRuntimeOwnsHostReadiness = managedLocalGatewayEnabled
    ? configuredRuntimeProviderOwnsHostReadiness({
        environment: process.env,
        platform: "linux",
      })
    : false;
  const admission = evaluateOnboardReadinessAdmission(readinessReport, {
    explicitlyOptedOutGpuPassthrough: options.explicitlyOptedOutGpuPassthrough,
    allowUnsupportedRuntime: portable || !managedLocalGatewayEnabled,
    providerOwnsHostReadiness: selectedRuntimeOwnsHostReadiness,
    allowStorageRemediation: options.allowStorageRemediation === true,
    allowPortableHostPreparation: options.allowPortableHostPreparation,
    allowDeferredN1xManagedVllm:
      options.allowDeferredN1xManagedVllm ??
      process.env.NEMOCLAW_PROVIDER === MANAGED_VLLM_PROVIDER_KEY,
  });
  const advisories = planHostAdvisories(host, {
    providerOwnsHostReadiness: selectedRuntimeOwnsHostReadiness,
    resuming: options.resuming,
  });
  if (admission.admitted) {
    if (options.presentAdvisories !== false) {
      printRemediationActions(advisories.filter(({ severity }) => severity === "warning"));
    }
    return readinessReport;
  }
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

/** Collect and admit production gateway facts before onboarding effects. */
export async function collectOnboardGatewayReadiness(
  options: ProductionGatewayReadinessOptions,
): Promise<CollectedGatewayReadiness> {
  const snapshot = await collectGatewayObservations(
    createProductionGatewayReadinessDependencies(options),
  );
  const projection = projectGatewayReadiness(snapshot);
  assertOnboardGatewayReadiness(projection);
  return { projection, snapshot };
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

interface RuntimeGpuReadiness {
  value: GpuDetection | null;
  wslDockerDesktopGpuProofPassed?: boolean;
  gpuTrustGateRejection?: string;
}

interface CollectedOnboardHostReadiness {
  result: FatalRuntimePreflightResult;
  snapshot: HostObservationSnapshot;
}

function collectOnboardHostReadiness(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
  allowStorageRemediation: boolean,
  runtimeGpu?: RuntimeGpuReadiness,
): CollectedOnboardHostReadiness {
  const now = context.now ?? (() => new Date());
  const host = (context.assessHost ?? assessHost)();
  let gpuTrustGateRejection: string | undefined;
  const gpu = runtimeGpu
    ? runtimeGpu.value
    : (context.detectGpu ?? detectGpu)({
        proveArm64WslDockerDesktopGpu: null,
        onTrustGateRejection: (reason) => {
          gpuTrustGateRejection = reason;
        },
      });
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  const snapshot = collectHostObservations({
    assess: () => host,
    detectGpu: () => gpu,
    wslDockerDesktopGpuProofPassed: runtimeGpu?.wslDockerDesktopGpuProofPassed,
    now,
  });
  const readinessReport = projectHostReadiness(snapshot, {
    ...getBuildIdentity(),
    now,
  });
  assertOnboardSystemReadiness(readinessReport, host, {
    explicitlyOptedOutGpuPassthrough:
      sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    wslDockerDesktopGpuProofPassed: runtimeGpu?.wslDockerDesktopGpuProofPassed,
    resuming: context.resuming,
    allowStorageRemediation,
    allowDeferredN1xManagedVllm: options.allowDeferredN1xManagedVllm,
    // The initial host readiness gate already presented warning advisories.
    presentAdvisories: false,
    exitProcess: context.exitProcess,
  });
  return {
    result: {
      gpu,
      host,
      readinessReport,
      sandboxGpuConfig,
      ...(runtimeGpu?.gpuTrustGateRejection || gpuTrustGateRejection
        ? {
            gpuTrustGateRejection: runtimeGpu?.gpuTrustGateRejection ?? gpuTrustGateRejection,
          }
        : {}),
    },
    snapshot,
  };
}

function refreshOnboardHostReadiness(
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
  allowStorageRemediation: boolean,
  runtimeGpu?: RuntimeGpuReadiness,
): FatalRuntimePreflightResult {
  return collectOnboardHostReadiness(options, context, allowStorageRemediation, runtimeGpu).result;
}

function projectCollectedHostReadiness(
  collected: CollectedOnboardHostReadiness,
  evaluatedAt: Date,
): CollectedOnboardHostReadiness {
  return {
    ...collected,
    result: {
      ...collected.result,
      readinessReport: projectHostReadiness(collected.snapshot, {
        ...getBuildIdentity(),
        now: () => evaluatedAt,
      }),
    },
  };
}

function hasStaleHostEvidence(report: SystemReadinessReport): boolean {
  return report.evidence.some(({ id }) => id === "host.probe.stale");
}

async function collectAdmittedReadinessPair(
  collectedHost: CollectedOnboardHostReadiness,
  options: FatalRuntimePreflightOptions,
  context: ReadinessGatedRuntimePreflightContext,
  runtimeGpu?: RuntimeGpuReadiness,
): Promise<{
  host: CollectedOnboardHostReadiness;
  gateway: GatewayReadinessProjection;
  report: SystemReadinessReport;
}> {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  const now = context.now ?? (() => new Date());
  let collectedGateway = await context.collectGatewayReadiness();
  assertOnboardGatewayReadiness(collectedGateway.projection, exitProcess);

  let evaluatedAt = now();
  let gateway = projectGatewayReadiness(collectedGateway.snapshot, {
    now: () => evaluatedAt,
  });
  assertOnboardGatewayReadiness(gateway, exitProcess);
  let host = projectCollectedHostReadiness(collectedHost, evaluatedAt);

  if (hasStaleHostEvidence(host.result.readinessReport)) {
    host = collectOnboardHostReadiness(
      options,
      context,
      isManagedGatewayReadiness(gateway),
      runtimeGpu,
    );
    collectedGateway = await context.collectGatewayReadiness();
    assertOnboardGatewayReadiness(collectedGateway.projection, exitProcess);
    evaluatedAt = now();
    gateway = projectGatewayReadiness(collectedGateway.snapshot, {
      now: () => evaluatedAt,
    });
    assertOnboardGatewayReadiness(gateway, exitProcess);
    host = projectCollectedHostReadiness(host, evaluatedAt);
  }

  const report = composeSystemReadinessReport(host.result.readinessReport, gateway);
  assertOnboardSystemReadiness(report, host.result.host, {
    explicitlyOptedOutGpuPassthrough:
      host.result.sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    resuming: context.resuming,
    allowStorageRemediation: isManagedGatewayReadiness(gateway),
    allowDeferredN1xManagedVllm: options.allowDeferredN1xManagedVllm,
    presentAdvisories: false,
    exitProcess,
  });
  return { host, gateway, report };
}

/** Resolve the bounded WSL GPU proof only after canonical readiness admission. */
function resolveRuntimeGpuProof(
  result: FatalRuntimePreflightResult,
  options: FatalRuntimePreflightOptions,
  context: FatalRuntimePreflightContext,
): { result: FatalRuntimePreflightResult; proofRan: boolean } {
  if (!requiresRuntimeGpuProof(result, options)) return { result, proofRan: false };
  let gpuTrustGateRejection: string | undefined;
  const gpu = (context.detectGpu ?? detectGpu)({
    onTrustGateRejection: (reason) => {
      gpuTrustGateRejection = reason;
    },
  });
  const sandboxGpuConfig = resolveSandboxGpuConfig(gpu, {
    flag: resolveSandboxGpuFlagFromOptions(options),
    device: options.sandboxGpuDevice ?? null,
  });
  // The proof-phase detection replaces the observation-phase result, so its
  // rejection reason (or its absence, when the proof passed) replaces the
  // observation-phase reason too.
  return {
    result: { ...result, gpu, sandboxGpuConfig, gpuTrustGateRejection },
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
  const readinessReport = projectHostReadiness(snapshot, {
    ...getBuildIdentity(),
    now,
  });
  return assertOnboardSystemReadiness(readinessReport, host, options);
}

/** Run runtime probes that may pull an image or start a short-lived container. */
export function runOnboardRuntimeEffectfulPreflightChecks(
  result: FatalRuntimePreflightResult,
  context: FatalRuntimePreflightContext,
): void {
  const exitProcess = context.exitProcess ?? exitProcessByDefault;
  exitOnSandboxGpuConfigErrors(result.sandboxGpuConfig, exitProcess);
  (context.warnIfHostProxyMissesLoopback ?? warnIfHostProxyMissesLoopback)();
  const assertRuntimeProviderHealthy = context.assertRuntimeProviderHealthy;
  if (assertRuntimeProviderHealthy) {
    assertRuntimeProviderHealthy(
      result.host,
      result.sandboxGpuConfig,
      context.nonInteractive,
      exitProcess,
    );
  } else {
    assertConfiguredRuntimeProviderHealthy(
      result.host,
      result.sandboxGpuConfig,
      context.nonInteractive,
      exitProcess,
      {
        validatePortableSandboxGpuPreflight:
          context.validateSandboxGpuPreflight ?? validateSandboxGpuPreflight,
      },
    );
  }
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
  const gatewayBeforePreparation = (await context.collectGatewayReadiness()).projection;
  assertOnboardGatewayReadiness(gatewayBeforePreparation, exitProcess);
  runFatalOnboardRuntimePreflight(options, {
    ...context,
    allowStorageRemediation: isManagedGatewayReadiness(gatewayBeforePreparation),
    deferEffectfulChecks: true,
  });
  let gatewayReadiness = (await context.collectGatewayReadiness()).projection;
  assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
  let managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
  let collectedHost = collectOnboardHostReadiness(options, context, managedGatewayReadiness);
  let admitted = await collectAdmittedReadinessPair(collectedHost, options, context);
  collectedHost = admitted.host;
  let refreshedResult = collectedHost.result;
  gatewayReadiness = admitted.gateway;
  managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);

  // The only GPU detection path that may pull or start a container is delayed
  // until both canonical host and gateway reports have admitted the run.
  const runtimeGpu = resolveRuntimeGpuProof(refreshedResult, options, {
    ...context,
    allowStorageRemediation: managedGatewayReadiness,
  });
  let runtimeGpuReadiness: RuntimeGpuReadiness | undefined;
  if (runtimeGpu.proofRan) {
    // An explicit GPU request cannot fall back to CPU after a failed proof.
    // Reject that known configuration error before any later container probe.
    exitOnSandboxGpuConfigErrors(runtimeGpu.result.sandboxGpuConfig, exitProcess);
    runtimeGpuReadiness = {
      value: runtimeGpu.result.gpu,
      // `detectGpu()` rejects a failed bounded proof by returning null. Keep
      // that negative outcome distinct from the observation-only phase's
      // intentionally unknown result. A normal trusted WSL GPU has no proof
      // marker and remains unknown because no bounded proof was necessary.
      wslDockerDesktopGpuProofPassed:
        runtimeGpu.result.gpu === null
          ? false
          : runtimeGpu.result.gpu.wslDockerDesktopGpuProofPassed,
      gpuTrustGateRejection: runtimeGpu.result.gpuTrustGateRejection,
    };
    collectedHost = collectOnboardHostReadiness(
      options,
      context,
      managedGatewayReadiness,
      runtimeGpuReadiness,
    );
  }

  admitted = await collectAdmittedReadinessPair(
    collectedHost,
    options,
    context,
    runtimeGpuReadiness,
  );
  refreshedResult = admitted.host.result;
  gatewayReadiness = admitted.gateway;
  const readinessReport = admitted.report;
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

  const readinessReport = assertOnboardHostReadiness(host, gpu, {
    explicitlyOptedOutGpuPassthrough,
    resuming: context.resuming,
    allowStorageRemediation: context.allowStorageRemediation,
    allowDeferredN1xManagedVllm: options.allowDeferredN1xManagedVllm,
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
