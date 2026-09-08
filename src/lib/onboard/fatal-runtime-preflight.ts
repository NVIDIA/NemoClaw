// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getBuildIdentity } from "../core/version";
import { detectGpu, type DetectGpuDeps, type GpuDetection } from "../inference/nim";
import { isWsl as detectWsl } from "../platform";
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
  collectN1xWslProductObservation,
  type HostObservationSnapshot,
  projectHostReadiness,
} from "../readiness/host";
import {
  evaluateOnboardGatewayReadinessAdmission,
  evaluateOnboardReadinessAdmission,
  hasExplicitDeferredN1xOnboardingIntent,
} from "../readiness/onboard-admission";
import { composeSystemReadinessReport } from "../readiness/system";
import type { SystemReadinessReport } from "../readiness/types";
import {
  isLinuxDockerDriverGatewayEnabled,
  isPortableExperimentalProfile,
} from "./docker-driver-platform";
import { configuredRuntimeProviderReadinessAuthority } from "./docker-driver-gateway-env";
import { warnIfHostProxyMissesLoopback } from "./http-proxy-preflight";
import { assertConfiguredRuntimeProviderHealthy } from "./machine/runtime-effectful-preflight";
import { assessHost, type HostAssessment, planHostAdvisories } from "./preflight";
import {
  printCdiSpecUnavailableError,
  printDockerNotReachableError,
  printUnsupportedRuntimeError,
} from "./preflight-messages";
import { printRemediationActions } from "./remediation";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import { createArm64ContainerGpuProver } from "./runtime-provider/nvidia-container-proof";
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
   * override so the provider-owned bounded proof can run when needed.
   */
  detectGpu?: typeof detectGpu;
  createArm64ContainerGpuProver?: typeof createArm64ContainerGpuProver;
  runCaptureImpl?: DetectGpuDeps["runCaptureImpl"];
  collectN1xWslProduct?: NonNullable<Parameters<typeof collectN1xWslProductObservation>[1]>;
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
  /** One immutable product observation shared by GPU and readiness classification. */
  n1xWslProduct: boolean | null;
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
  /** Preserve provider-bound proof state across readiness collection phases. */
  containerGpuProof?: GpuDetection["containerGpuProof"];
  n1xWslProduct?: boolean | null;
  resuming?: boolean;
  allowStorageRemediation?: boolean;
  allowPortableHostPreparation?: boolean;
  /** A trusted current or recorded choice may exercise the Deferred N1x path. */
  allowDeferredN1xOnboarding?: boolean;
  /** Print warning-severity host advisories before returning an admitted report. */
  presentAdvisories?: boolean;
  exitProcess?: (code: number) => never;
  observedAt?: string;
  now?: () => Date;
}

function runtimeProviderReadinessAuthority(host: HostAssessment) {
  const managedLocalGatewayEnabled =
    host.platform === "linux" && isLinuxDockerDriverGatewayEnabled("linux");
  return managedLocalGatewayEnabled
    ? configuredRuntimeProviderReadinessAuthority({
        environment: process.env,
        platform: "linux",
      })
    : null;
}

function detectGpuWithBoundProviderProof(
  deps: Omit<DetectGpuDeps, "proveArm64ContainerGpu"> = {},
  runtimeProvider?: RuntimeProviderBundle,
): GpuDetection | null {
  const n1xWslProduct = Object.prototype.hasOwnProperty.call(deps, "n1xWslProduct")
    ? (deps.n1xWslProduct ?? null)
    : collectN1xWslProductObservation(deps.isWsl ?? detectWsl());
  return detectGpu({
    ...deps,
    n1xWslProduct,
    proveArm64ContainerGpu: createArm64ContainerGpuProver({
      ...(runtimeProvider ? { resolveRuntimeProvider: () => runtimeProvider } : {}),
    }),
  });
}

/** Effectful GPU detection with the selected provider's bounded proof wired. */
export function detectGpuWithRuntimeProviderProof(
  deps: Omit<DetectGpuDeps, "proveArm64ContainerGpu"> = {},
): GpuDetection | null {
  return detectGpuWithBoundProviderProof(deps);
}

/** Effectful GPU detection bound to one recorded runtime-provider identity. */
export function detectGpuWithRuntimeProviderProofForProvider(
  providerId: string | null | undefined,
  deps: Omit<DetectGpuDeps, "proveArm64ContainerGpu"> = {},
): GpuDetection | null {
  const provider = (
    require("./runtime-provider/selection") as typeof import("./runtime-provider/selection")
  ).resolveRegisteredRuntimeProvider(providerId);
  return provider ? detectGpuWithBoundProviderProof(deps, provider) : null;
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
  const providerAuthority = runtimeProviderReadinessAuthority(host);
  const managedLocalGatewayEnabled = providerAuthority !== null;
  const selectedRuntimeOwnsHostReadiness = providerAuthority?.ownsHostReadiness === true;
  const admission = evaluateOnboardReadinessAdmission(readinessReport, {
    explicitlyOptedOutGpuPassthrough: options.explicitlyOptedOutGpuPassthrough,
    allowUnsupportedRuntime: portable || !managedLocalGatewayEnabled,
    providerOwnsHostReadiness: selectedRuntimeOwnsHostReadiness,
    allowStorageRemediation: options.allowStorageRemediation === true,
    allowPortableHostPreparation: options.allowPortableHostPreparation,
    allowDeferredN1xManagedVllm:
      options.allowDeferredN1xOnboarding ?? hasExplicitDeferredN1xOnboardingIntent(process.env),
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
    result.host.hasNvidiaGpu &&
    result.gpu?.containerGpuProof?.passed !== true &&
    result.sandboxGpuConfig.mode !== "0" &&
    options.optedOutGpuPassthrough !== true
  );
}

interface RuntimeGpuReadiness {
  value: GpuDetection | null;
  containerGpuProof?: GpuDetection["containerGpuProof"];
  n1xWslProduct: boolean | null;
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
  identity?: Readonly<{ n1xWslProduct: boolean | null }>,
): CollectedOnboardHostReadiness {
  const now = context.now ?? (() => new Date());
  const host = (context.assessHost ?? assessHost)();
  const runtimeProvider = runtimeProviderReadinessAuthority(host);
  const n1xWslProduct = runtimeGpu
    ? runtimeGpu.n1xWslProduct
    : identity
      ? identity.n1xWslProduct
      : collectN1xWslProductObservation(host.isWsl, context.collectN1xWslProduct);
  let gpuTrustGateRejection: string | undefined;
  const gpu = runtimeGpu
    ? runtimeGpu.value
    : (context.detectGpu ?? detectGpu)({
        proveArm64ContainerGpu: null,
        n1xWslProduct,
        runCaptureImpl: context.runCaptureImpl,
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
    runtimeProvider: runtimeProvider ?? undefined,
    containerGpuProof: runtimeGpu?.containerGpuProof,
    platformIdentityOptions: { n1xWslProductObservation: n1xWslProduct },
    now,
  });
  const readinessReport = projectHostReadiness(snapshot, {
    ...getBuildIdentity(),
    now,
  });
  assertOnboardSystemReadiness(readinessReport, host, {
    explicitlyOptedOutGpuPassthrough:
      sandboxGpuConfig.mode === "0" || options.optedOutGpuPassthrough === true,
    containerGpuProof: runtimeGpu?.containerGpuProof,
    resuming: context.resuming,
    allowStorageRemediation,
    allowDeferredN1xOnboarding: options.allowDeferredN1xManagedVllm,
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
      n1xWslProduct,
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
      { n1xWslProduct: collectedHost.result.n1xWslProduct },
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
    allowDeferredN1xOnboarding: options.allowDeferredN1xManagedVllm,
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
): {
  result: FatalRuntimePreflightResult;
  proofRan: boolean;
  containerGpuProof?: GpuDetection["containerGpuProof"];
} {
  if (!requiresRuntimeGpuProof(result, options)) return { result, proofRan: false };
  let gpuTrustGateRejection: string | undefined;
  let containerGpuProof: GpuDetection["containerGpuProof"];
  const n1xWslProduct = result.n1xWslProduct;
  const gpu = (context.detectGpu ?? detectGpu)({
    proveArm64ContainerGpu: (
      context.createArm64ContainerGpuProver ?? createArm64ContainerGpuProver
    )(),
    n1xWslProduct,
    runCaptureImpl: context.runCaptureImpl,
    onTrustGateRejection: (reason) => {
      gpuTrustGateRejection = reason;
    },
    onContainerGpuProof: (proof) => {
      containerGpuProof = proof;
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
    containerGpuProof,
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
  const hasN1xWslProductObservation =
    Object.prototype.hasOwnProperty.call(options, "n1xWslProduct") ||
    Boolean(gpu && Object.prototype.hasOwnProperty.call(gpu, "n1xWslProduct"));
  const n1xWslProductObservation = Object.prototype.hasOwnProperty.call(options, "n1xWslProduct")
    ? (options.n1xWslProduct ?? null)
    : (gpu?.n1xWslProduct ?? null);
  const snapshot = collectHostObservations({
    assess: () => host,
    detectGpu: () => gpu,
    runtimeProvider: runtimeProviderReadinessAuthority(host) ?? undefined,
    containerGpuProof: options.containerGpuProof,
    ...(hasN1xWslProductObservation
      ? { platformIdentityOptions: { n1xWslProductObservation } }
      : {}),
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
  const initialHost = runFatalOnboardRuntimePreflight(options, {
    ...context,
    allowStorageRemediation: isManagedGatewayReadiness(gatewayBeforePreparation),
    deferEffectfulChecks: true,
  });
  let gatewayReadiness = (await context.collectGatewayReadiness()).projection;
  assertOnboardGatewayReadiness(gatewayReadiness, exitProcess);
  let managedGatewayReadiness = isManagedGatewayReadiness(gatewayReadiness);
  let collectedHost = collectOnboardHostReadiness(
    options,
    context,
    managedGatewayReadiness,
    undefined,
    { n1xWslProduct: initialHost.n1xWslProduct },
  );
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
      containerGpuProof: runtimeGpu.containerGpuProof ?? runtimeGpu.result.gpu?.containerGpuProof,
      n1xWslProduct: runtimeGpu.result.n1xWslProduct,
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
  const n1xWslProduct = collectN1xWslProductObservation(host.isWsl, context.collectN1xWslProduct);
  let gpu = detect({
    proveArm64ContainerGpu: null,
    n1xWslProduct,
    runCaptureImpl: context.runCaptureImpl,
  });
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
    allowDeferredN1xOnboarding: options.allowDeferredN1xManagedVllm,
    exitProcess,
    observedAt,
    now,
    n1xWslProduct,
  });
  let result = { gpu, host, readinessReport, sandboxGpuConfig, n1xWslProduct };
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
          containerGpuProof:
            runtimeGpu.containerGpuProof ?? runtimeGpu.result.gpu?.containerGpuProof,
          n1xWslProduct: runtimeGpu.result.n1xWslProduct,
        })
      : runtimeGpu.result;
    runOnboardRuntimeEffectfulPreflightChecks(result, context);
  }
  return result;
}
