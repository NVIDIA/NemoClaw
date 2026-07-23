// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostAssessment } from "../onboard/preflight.js";
import { assessHost } from "../onboard/preflight.js";
import {
  SYSTEM_READINESS_SCHEMA_VERSION,
  type EvidenceScalar,
  type FindingSeverity,
  type ReadinessCapability,
  type ReadinessEvidence,
  type ReadinessFinding,
  type ReadinessObservation,
  type ReadinessState,
  type SystemReadinessReport,
} from "./types.js";

const DEFAULT_MAX_AGE_MS = 30_000;
const MAX_EVIDENCE_LENGTH = 1024;
const SECRET_PATTERN =
  /(?:\bauthorization\s*:\s*bearer\s+[^\s,;]+|\b(?:bearer\s+)?(?:gh[opusr]_[a-z0-9_]{20,}|nvapi-[a-z0-9_-]{16,}|sk-[a-z0-9_-]{16,}|(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+))/gi;

export interface HostObservations {
  platform: string;
  architecture: string;
  isWsl: boolean;
  isHeadlessLikely: boolean;
  dockerInstalled: boolean;
  dockerReachable: boolean;
  runtime: string;
  dockerCgroupVersion?: string;
  dockerDefaultCgroupnsMode?: string;
  dockerStorageDriver?: string;
  dockerUsesContainerdSnapshotter?: boolean;
  dockerCpus?: number;
  dockerMemTotalBytes?: number;
  isContainerRuntimeUnderProvisioned: boolean;
  hasNestedOverlayConflict: boolean;
  isUnsupportedRuntime: boolean;
  nodeInstalled: boolean;
  openshellInstalled: boolean;
  hasNvidiaGpu: boolean;
  hostGpuPlatform?: string;
  nvidiaContainerToolkitInstalled: boolean;
  dockerCdiSpecDirs: readonly string[];
  cdiNvidiaGpuSpecMissing: boolean;
  cdiNvidiaGpuSpecStale?: boolean;
  cdiNvidiaGpuSpecNeedsRepair?: boolean;
}

export interface HostObservationSnapshot {
  observedAt: string;
  observations?: Readonly<HostObservations>;
  failure?: string;
  reusable?: boolean;
}

export interface CollectHostObservationsOptions {
  assess?: () => HostAssessment;
  architecture?: string;
  hostGpuPlatform?: string;
  now?: () => Date;
}

export interface CreateHostReadinessReportOptions {
  nemoclawVersion: string;
  sourceRevision?: string;
  now?: () => Date;
  maxObservationAgeMs?: number;
}

function safeEvidence(value: string): string {
  return value.replace(SECRET_PATTERN, "[REDACTED]").slice(0, MAX_EVIDENCE_LENGTH);
}

function adaptHostAssessment(
  host: Readonly<HostAssessment>,
  architecture: string,
  hostGpuPlatform?: string,
): HostObservations {
  return {
    platform: host.platform,
    architecture,
    isWsl: host.isWsl,
    isHeadlessLikely: host.isHeadlessLikely,
    dockerInstalled: host.dockerInstalled,
    dockerReachable: host.dockerReachable,
    runtime: host.runtime,
    dockerCgroupVersion: host.dockerCgroupVersion,
    dockerDefaultCgroupnsMode: host.dockerDefaultCgroupnsMode,
    dockerStorageDriver: host.dockerStorageDriver,
    dockerUsesContainerdSnapshotter: host.dockerUsesContainerdSnapshotter,
    dockerCpus: host.dockerCpus,
    dockerMemTotalBytes: host.dockerMemTotalBytes,
    isContainerRuntimeUnderProvisioned: host.isContainerRuntimeUnderProvisioned,
    hasNestedOverlayConflict: host.hasNestedOverlayConflict,
    isUnsupportedRuntime: host.isUnsupportedRuntime,
    nodeInstalled: host.nodeInstalled,
    openshellInstalled: host.openshellInstalled,
    hasNvidiaGpu: host.hasNvidiaGpu,
    hostGpuPlatform,
    nvidiaContainerToolkitInstalled: host.nvidiaContainerToolkitInstalled,
    dockerCdiSpecDirs: [...host.dockerCdiSpecDirs],
    cdiNvidiaGpuSpecMissing: host.cdiNvidiaGpuSpecMissing,
    cdiNvidiaGpuSpecStale: host.cdiNvidiaGpuSpecStale,
    cdiNvidiaGpuSpecNeedsRepair: host.cdiNvidiaGpuSpecNeedsRepair,
  };
}

export function collectHostObservations(
  options: CollectHostObservationsOptions = {},
): HostObservationSnapshot {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    const assessment = (options.assess ?? assessHost)();
    return {
      observedAt,
      observations: adaptHostAssessment(
        assessment,
        options.architecture ?? process.arch,
        options.hostGpuPlatform,
      ),
      reusable: false,
    };
  } catch (error) {
    return {
      observedAt,
      failure: safeEvidence(error instanceof Error ? error.message : String(error)),
      reusable: false,
    };
  }
}

function observation(id: string, value: EvidenceScalar | undefined): ReadinessObservation {
  if (value === undefined || value === null || value === "unknown") return { id, state: "unknown" };
  if (typeof value === "boolean") return { id, state: value ? "present" : "absent", value };
  return { id, state: "present", value };
}

function capability(id: string, state: ReadinessState): ReadinessCapability {
  return { id, state };
}

function finding(
  id: string,
  severity: FindingSeverity,
  summary: string,
  capabilityIds: readonly string[],
): ReadinessFinding {
  return { id, severity, summary, capabilityIds };
}

function stateOf(value: boolean | undefined): ReadinessState {
  return value === undefined ? "unknown" : value ? "present" : "absent";
}

function unknownProjection(evidenceIds: readonly string[]): {
  observations: ReadinessObservation[];
  capabilities: ReadinessCapability[];
  findings: ReadinessFinding[];
} {
  const observationIds = [
    "host.os.platform",
    "host.os.architecture",
    "host.os.wsl",
    "host.session.headless",
    "host.docker.installed",
    "host.docker.reachable",
    "host.docker.runtime",
    "host.docker.cpus",
    "host.docker.memory_bytes",
    "host.docker.cgroup_version",
    "host.docker.cgroupns_mode",
    "host.docker.storage_driver",
    "host.docker.containerd_snapshotter",
    "host.toolchain.node",
    "host.toolchain.openshell",
    "host.gpu.nvidia",
    "host.gpu.container_toolkit",
    "host.gpu.cdi",
    "host.gpu.cdi_stale",
  ];
  const capabilityIds = [
    "host.docker.available",
    "host.docker.daemon_reachable",
    "host.docker.runtime_supported",
    "host.docker.resources_sufficient",
    "host.docker.storage_compatible",
    "host.toolchain.node_available",
    "host.toolchain.openshell_available",
    "host.gpu.nvidia_available",
    "host.gpu.container_toolkit_available",
    "host.gpu.cdi_healthy",
  ];
  return {
    observations: observationIds.map((id) => ({ id, state: "unknown", evidenceIds })),
    capabilities: capabilityIds.map((id) => ({ id, state: "unknown", evidenceIds })),
    findings: [
      {
        id: "host.probe.inconclusive",
        severity: "warning",
        summary: "Host observations could not be collected safely.",
        evidenceIds,
      },
    ],
  };
}

export function projectHostReadiness(
  snapshot: Readonly<HostObservationSnapshot>,
  options: CreateHostReadinessReportOptions,
): SystemReadinessReport {
  const now = (options.now ?? (() => new Date()))();
  const age = now.getTime() - Date.parse(snapshot.observedAt);
  const stale =
    !Number.isFinite(age) || age < 0 || age > (options.maxObservationAgeMs ?? DEFAULT_MAX_AGE_MS);
  const unsafeReuse = stale && snapshot.reusable !== true;
  const evidence: ReadinessEvidence[] = [];
  if (snapshot.failure) {
    evidence.push({ id: "host.probe.failure", summary: safeEvidence(snapshot.failure) });
  }
  if (unsafeReuse) {
    evidence.push({
      id: "host.probe.stale",
      summary: "Host observations exceeded their safe reuse window.",
    });
  }

  let observations: ReadinessObservation[];
  let capabilities: ReadinessCapability[];
  let findings: ReadinessFinding[];
  const host = snapshot.observations;
  if (!host || snapshot.failure || unsafeReuse) {
    const projected = unknownProjection(evidence.map(({ id }) => id));
    ({ observations, capabilities, findings } = projected);
  } else {
    const cdiApplies =
      host.platform === "linux" &&
      host.hasNvidiaGpu &&
      host.dockerCdiSpecDirs.length > 0 &&
      host.hostGpuPlatform !== "jetson" &&
      !(host.isWsl && host.runtime === "docker-desktop");
    const cdiHealthy = cdiApplies
      ? !host.cdiNvidiaGpuSpecMissing && !host.cdiNvidiaGpuSpecNeedsRepair
      : undefined;
    observations = [
      observation("host.os.platform", host.platform),
      observation("host.os.architecture", host.architecture),
      observation("host.os.wsl", host.isWsl),
      observation("host.session.headless", host.isHeadlessLikely),
      observation("host.docker.installed", host.dockerInstalled),
      observation("host.docker.reachable", host.dockerReachable),
      observation("host.docker.runtime", host.dockerReachable ? host.runtime : undefined),
      observation("host.docker.cpus", host.dockerReachable ? host.dockerCpus : undefined),
      observation(
        "host.docker.memory_bytes",
        host.dockerReachable ? host.dockerMemTotalBytes : undefined,
      ),
      observation(
        "host.docker.cgroup_version",
        host.dockerReachable ? host.dockerCgroupVersion : undefined,
      ),
      observation(
        "host.docker.cgroupns_mode",
        host.dockerReachable ? host.dockerDefaultCgroupnsMode : undefined,
      ),
      observation(
        "host.docker.storage_driver",
        host.dockerReachable ? host.dockerStorageDriver : undefined,
      ),
      observation(
        "host.docker.containerd_snapshotter",
        host.dockerReachable ? host.dockerUsesContainerdSnapshotter : undefined,
      ),
      observation("host.toolchain.node", host.nodeInstalled),
      observation("host.toolchain.openshell", host.openshellInstalled),
      observation("host.gpu.nvidia", host.hasNvidiaGpu),
      observation(
        "host.gpu.container_toolkit",
        host.hasNvidiaGpu ? host.nvidiaContainerToolkitInstalled : undefined,
      ),
      observation("host.gpu.cdi", cdiHealthy),
      observation("host.gpu.cdi_stale", cdiApplies ? host.cdiNvidiaGpuSpecStale : undefined),
    ];
    capabilities = [
      capability("host.docker.available", stateOf(host.dockerInstalled)),
      capability(
        "host.docker.daemon_reachable",
        host.dockerInstalled ? stateOf(host.dockerReachable) : "absent",
      ),
      capability(
        "host.docker.runtime_supported",
        host.dockerReachable ? stateOf(!host.isUnsupportedRuntime) : "unknown",
      ),
      capability(
        "host.docker.resources_sufficient",
        host.dockerReachable ? stateOf(!host.isContainerRuntimeUnderProvisioned) : "unknown",
      ),
      capability(
        "host.docker.storage_compatible",
        host.dockerReachable ? stateOf(!host.hasNestedOverlayConflict) : "unknown",
      ),
      capability("host.toolchain.node_available", stateOf(host.nodeInstalled)),
      capability("host.toolchain.openshell_available", stateOf(host.openshellInstalled)),
      capability("host.gpu.nvidia_available", stateOf(host.hasNvidiaGpu)),
      capability(
        "host.gpu.container_toolkit_available",
        host.hasNvidiaGpu ? stateOf(host.nvidiaContainerToolkitInstalled) : "unknown",
      ),
      capability("host.gpu.cdi_healthy", stateOf(cdiHealthy)),
    ];
    findings = [];
    if (!host.dockerInstalled)
      findings.push(
        finding("host.docker.unavailable", "blocking", "Docker is not installed.", [
          "host.docker.available",
        ]),
      );
    else if (!host.dockerReachable)
      findings.push(
        finding("host.docker.daemon_unreachable", "blocking", "The Docker daemon is unreachable.", [
          "host.docker.daemon_reachable",
        ]),
      );
    if (host.isContainerRuntimeUnderProvisioned)
      findings.push(
        finding(
          "host.docker.resources_insufficient",
          "warning",
          "Container runtime resources are below recommendations.",
          ["host.docker.resources_sufficient"],
        ),
      );
    if (host.isUnsupportedRuntime)
      findings.push(
        finding(
          "host.docker.runtime_unsupported",
          "warning",
          "The detected container runtime is unsupported.",
          ["host.docker.runtime_supported"],
        ),
      );
    if (host.hasNvidiaGpu && !host.nvidiaContainerToolkitInstalled)
      findings.push(
        finding(
          "host.gpu.container_toolkit_missing",
          "blocking",
          "NVIDIA Container Toolkit is missing.",
          ["host.gpu.container_toolkit_available"],
        ),
      );
    if (cdiApplies && host.cdiNvidiaGpuSpecMissing)
      findings.push(
        finding("host.gpu.cdi_missing", "blocking", "The NVIDIA CDI specification is missing.", [
          "host.gpu.cdi_healthy",
        ]),
      );
    if (cdiApplies && host.cdiNvidiaGpuSpecStale)
      findings.push(
        finding("host.gpu.cdi_stale", "blocking", "The NVIDIA CDI specification is stale.", [
          "host.gpu.cdi_healthy",
        ]),
      );
  }

  const hasBlocking = findings.some(
    ({ severity }) => severity === "blocking" || severity === "fatal",
  );
  const hasUnknown = capabilities.some(({ state }) => state === "unknown");
  const status = hasBlocking ? "incompatible" : hasUnknown ? "inconclusive" : "supported";
  return {
    schemaVersion: SYSTEM_READINESS_SCHEMA_VERSION,
    status,
    exitCode: status === "supported" ? 0 : status === "incompatible" ? 2 : 3,
    mutated: false,
    provenance: {
      nemoclawVersion: options.nemoclawVersion,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
      observedAt: snapshot.observedAt,
    },
    observations,
    capabilities,
    qualifications: [],
    findings,
    evidence,
  };
}

export function createHostReadinessReport(
  options: CreateHostReadinessReportOptions,
  collectionOptions: CollectHostObservationsOptions = {},
): SystemReadinessReport {
  const now = options.now ?? collectionOptions.now ?? (() => new Date());
  return projectHostReadiness(collectHostObservations({ ...collectionOptions, now }), {
    ...options,
    now,
  });
}
