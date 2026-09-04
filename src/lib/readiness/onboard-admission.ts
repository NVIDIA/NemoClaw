// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReadinessCapability, ReadinessFinding, SystemReadinessReport } from "./types";

export const ONBOARD_READINESS_ADMISSION_REASON_IDS = {
  blockingFindings: "onboard.readiness.blocking_findings",
  requiredCapabilitiesUnknown: "onboard.readiness.required_capabilities_unknown",
} as const;

export type OnboardReadinessAdmissionReasonId =
  (typeof ONBOARD_READINESS_ADMISSION_REASON_IDS)[keyof typeof ONBOARD_READINESS_ADMISSION_REASON_IDS];

export const ONBOARD_READINESS_FINDING_IDS = {
  containerToolkitMissing: "host.gpu.container_toolkit_missing",
  cdiMissing: "host.gpu.cdi_missing",
  cdiStale: "host.gpu.cdi_stale",
  nvidiaRuntimeMissing: "host.gpu.nvidia_runtime_missing",
  dockerUnavailable: "host.docker.unavailable",
  dockerHostInvalid: "host.docker.host_invalid",
  dockerDaemonUnreachable: "host.docker.daemon_unreachable",
  runtimeUnsupported: "host.docker.runtime_unsupported",
  storageIncompatible: "host.docker.storage_incompatible",
  gatewayVersionDrift: "gateway.version.drift",
  n1xValidationPending: "host.platform.n1x_validation_pending",
} as const;

export const ONBOARD_REQUIRED_CAPABILITY_IDS = {
  dockerAvailable: "host.docker.available",
  dockerDaemonReachable: "host.docker.daemon_reachable",
  dockerRuntimeSupported: "host.docker.runtime_supported",
  dockerStorageCompatible: "host.docker.storage_compatible",
  dockerStorageRemediationAvailable: "host.docker.storage_remediation_available",
  nvidiaGpuAvailable: "host.gpu.nvidia_available",
  nvidiaContainerToolkitAvailable: "host.gpu.container_toolkit_available",
  nvidiaCdiHealthy: "host.gpu.cdi_healthy",
  platformSupported: "host.platform.supported",
  gatewayAuthorityResolved: "gateway.authority.resolved",
  gatewayAttachmentValid: "gateway.attachment.valid",
  gatewayReuseReady: "gateway.reuse.ready",
  gatewayVersionCompatible: "gateway.version.compatible",
  gatewayPortUncontested: "gateway.port.uncontested",
} as const;

export interface OnboardReadinessAdmissionOptions {
  /** CPU-only intent makes NVIDIA host integration irrelevant to this run. */
  explicitlyOptedOutGpuPassthrough: boolean;
  /** This run has an explicit runtime path that does not require the standard Docker driver. */
  allowUnsupportedRuntime: boolean;
  /** A selected registered provider owns host readiness instead of the standard Docker driver. */
  providerOwnsHostReadiness?: boolean;
  /** The lifecycle may build the documented patched gateway image for the storage conflict. */
  allowStorageRemediation: boolean;
  /** The explicit portable profile may prepare its rootless runtime before revalidation. */
  allowPortableHostPreparation?: boolean;
  /** Explicit managed-vLLM intent may exercise the Deferred N1x validation path. */
  allowDeferredN1xManagedVllm?: boolean;
}

export type OnboardReadinessAdmissionDecision =
  | {
      admitted: true;
      waivedFindingIds: readonly string[];
    }
  | {
      admitted: false;
      reasonIds: readonly OnboardReadinessAdmissionReasonId[];
      findingIds: readonly string[];
      capabilityIds: readonly string[];
      waivedFindingIds: readonly string[];
    };

const GPU_FINDINGS = new Set<string>([
  ONBOARD_READINESS_FINDING_IDS.containerToolkitMissing,
  ONBOARD_READINESS_FINDING_IDS.cdiMissing,
  ONBOARD_READINESS_FINDING_IDS.cdiStale,
  ONBOARD_READINESS_FINDING_IDS.nvidiaRuntimeMissing,
]);

const STANDARD_DOCKER_FINDINGS = new Set<string>([
  ONBOARD_READINESS_FINDING_IDS.dockerUnavailable,
  ONBOARD_READINESS_FINDING_IDS.dockerHostInvalid,
  ONBOARD_READINESS_FINDING_IDS.dockerDaemonUnreachable,
  ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported,
  ONBOARD_READINESS_FINDING_IDS.storageIncompatible,
]);

const STANDARD_DOCKER_REQUIRED_CAPABILITIES = new Set<string>([
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
]);

const ALWAYS_REQUIRED_CAPABILITIES = [
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerAvailable,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable,
  ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported,
  ONBOARD_REQUIRED_CAPABILITY_IDS.platformSupported,
] as const;

const GATEWAY_REQUIRED_CAPABILITIES = [
  ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAuthorityResolved,
  ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayAttachmentValid,
  ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayReuseReady,
  ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayVersionCompatible,
  ONBOARD_REQUIRED_CAPABILITY_IDS.gatewayPortUncontested,
] as const;

function capabilityState(
  capabilities: ReadonlyMap<string, ReadinessCapability>,
  id: string,
): ReadinessCapability["state"] | "missing" {
  return capabilities.get(id)?.state ?? "missing";
}

function isBlocking(finding: ReadinessFinding): boolean {
  return finding.severity === "blocking" || finding.severity === "fatal";
}

function canWaiveFinding(
  finding: ReadinessFinding,
  capabilities: ReadonlyMap<string, ReadinessCapability>,
  options: Readonly<OnboardReadinessAdmissionOptions>,
  managedGateway: boolean,
): boolean {
  if (options.explicitlyOptedOutGpuPassthrough && GPU_FINDINGS.has(finding.id)) return true;
  if (options.providerOwnsHostReadiness && STANDARD_DOCKER_FINDINGS.has(finding.id)) return true;
  if (
    options.allowUnsupportedRuntime &&
    finding.id === ONBOARD_READINESS_FINDING_IDS.runtimeUnsupported
  ) {
    return true;
  }
  if (
    options.allowPortableHostPreparation &&
    (finding.id === ONBOARD_READINESS_FINDING_IDS.dockerDaemonUnreachable ||
      finding.id === ONBOARD_READINESS_FINDING_IDS.storageIncompatible)
  ) {
    return true;
  }
  if (managedGateway && finding.id === ONBOARD_READINESS_FINDING_IDS.gatewayVersionDrift) {
    return true;
  }
  if (
    options.allowDeferredN1xManagedVllm &&
    finding.id === ONBOARD_READINESS_FINDING_IDS.n1xValidationPending &&
    capabilityState(capabilities, "host.platform.n1x") === "present"
  ) {
    return true;
  }
  return (
    options.allowStorageRemediation &&
    finding.id === ONBOARD_READINESS_FINDING_IDS.storageIncompatible &&
    capabilityState(
      capabilities,
      ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
    ) === "present"
  );
}

function addUnknownCapability(
  target: string[],
  capabilities: ReadonlyMap<string, ReadinessCapability>,
  id: string,
): void {
  const state = capabilityState(capabilities, id);
  if (state === "unknown" || state === "missing") target.push(id);
}

function requiredUnknownCapabilityIds(
  capabilities: ReadonlyMap<string, ReadinessCapability>,
  options: Readonly<OnboardReadinessAdmissionOptions>,
): readonly string[] {
  const unknown: string[] = [];
  for (const id of ALWAYS_REQUIRED_CAPABILITIES) {
    if (
      (options.providerOwnsHostReadiness && STANDARD_DOCKER_REQUIRED_CAPABILITIES.has(id)) ||
      (options.allowPortableHostPreparation &&
        (id === ONBOARD_REQUIRED_CAPABILITY_IDS.dockerDaemonReachable ||
          id === ONBOARD_REQUIRED_CAPABILITY_IDS.dockerRuntimeSupported))
    ) {
      continue;
    }
    addUnknownCapability(unknown, capabilities, id);
  }

  const storageCompatible = capabilityState(
    capabilities,
    ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
  );
  const storageRemediation = capabilityState(
    capabilities,
    ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
  );
  const storageRequirementSatisfied =
    options.providerOwnsHostReadiness === true ||
    options.allowPortableHostPreparation === true ||
    storageCompatible === "present" ||
    (options.allowStorageRemediation && storageRemediation === "present");
  if (!storageRequirementSatisfied) {
    if (storageCompatible === "unknown" || storageCompatible === "missing") {
      addUnknownCapability(
        unknown,
        capabilities,
        ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageCompatible,
      );
    }
    if (
      options.allowStorageRemediation &&
      storageRemediation !== "present" &&
      (storageRemediation === "unknown" || storageRemediation === "missing")
    ) {
      addUnknownCapability(
        unknown,
        capabilities,
        ONBOARD_REQUIRED_CAPABILITY_IDS.dockerStorageRemediationAvailable,
      );
    }
  }

  if (!options.explicitlyOptedOutGpuPassthrough) {
    addUnknownCapability(unknown, capabilities, ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaGpuAvailable);
    addUnknownCapability(
      unknown,
      capabilities,
      ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaContainerToolkitAvailable,
    );
    addUnknownCapability(unknown, capabilities, ONBOARD_REQUIRED_CAPABILITY_IDS.nvidiaCdiHealthy);
  }
  if (GATEWAY_REQUIRED_CAPABILITIES.some((id) => capabilities.has(id))) {
    for (const id of GATEWAY_REQUIRED_CAPABILITIES) addUnknownCapability(unknown, capabilities, id);
  }
  return unknown;
}

type OnboardReadinessInput = Pick<
  SystemReadinessReport,
  "observations" | "capabilities" | "findings"
>;

function hasManagedGateway(report: OnboardReadinessInput): boolean {
  return report.observations.some(
    ({ id, state, value }) =>
      id === "gateway.management.mode" && state === "present" && value === "nemoclaw-managed",
  );
}

function decisionFor(
  findingIds: readonly string[],
  capabilityIds: readonly string[],
  waivedFindingIds: readonly string[],
): OnboardReadinessAdmissionDecision {
  if (findingIds.length === 0 && capabilityIds.length === 0) {
    return { admitted: true, waivedFindingIds };
  }

  const reasonIds: OnboardReadinessAdmissionReasonId[] = [];
  if (findingIds.length > 0) {
    reasonIds.push(ONBOARD_READINESS_ADMISSION_REASON_IDS.blockingFindings);
  }
  if (capabilityIds.length > 0) {
    reasonIds.push(ONBOARD_READINESS_ADMISSION_REASON_IDS.requiredCapabilitiesUnknown);
  }
  return {
    admitted: false,
    reasonIds,
    findingIds,
    capabilityIds,
    waivedFindingIds,
  };
}

/**
 * Decide whether one onboarding run may proceed from the stable public
 * readiness entities. Consumer-specific exceptions are explicit and narrow;
 * every other blocking finding and every unknown required capability fails
 * closed before lifecycle effects begin.
 */
export function evaluateOnboardReadinessAdmission(
  report: Readonly<OnboardReadinessInput>,
  options: Readonly<OnboardReadinessAdmissionOptions>,
): OnboardReadinessAdmissionDecision {
  const capabilities = new Map(report.capabilities.map((entry) => [entry.id, entry]));
  const managedGateway = hasManagedGateway(report);
  const waivedFindingIds: string[] = [];
  const findingIds: string[] = [];
  for (const finding of report.findings) {
    if (!isBlocking(finding)) continue;
    if (canWaiveFinding(finding, capabilities, options, managedGateway)) {
      waivedFindingIds.push(finding.id);
    } else findingIds.push(finding.id);
  }

  const capabilityIds = [...requiredUnknownCapabilityIds(capabilities, options)];
  return decisionFor(findingIds, capabilityIds, waivedFindingIds);
}

/** Fail closed on gateway facts before any onboarding effect can run. */
export function evaluateOnboardGatewayReadinessAdmission(
  report: OnboardReadinessInput,
): OnboardReadinessAdmissionDecision {
  const capabilities = new Map(report.capabilities.map((entry) => [entry.id, entry]));
  const managedGateway = hasManagedGateway(report);
  const waivedFindingIds: string[] = [];
  const findingIds: string[] = [];
  for (const finding of report.findings) {
    if (!isBlocking(finding)) continue;
    if (
      canWaiveFinding(
        finding,
        capabilities,
        {
          explicitlyOptedOutGpuPassthrough: false,
          allowUnsupportedRuntime: false,
          allowStorageRemediation: false,
        },
        managedGateway,
      )
    ) {
      waivedFindingIds.push(finding.id);
    } else {
      findingIds.push(finding.id);
    }
  }
  const capabilityIds: string[] = [];
  for (const id of GATEWAY_REQUIRED_CAPABILITIES) {
    addUnknownCapability(capabilityIds, capabilities, id);
  }
  return decisionFor(findingIds, capabilityIds, waivedFindingIds);
}
