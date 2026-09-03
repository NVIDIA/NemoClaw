// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectGpu,
  detectNvidiaDriverVersion,
  detectNvidiaPlatform,
  type GpuDetection,
  type NvidiaPlatform,
} from "../inference/nim.js";
import type { HostAssessment } from "../onboard/preflight.js";
import { assessHost } from "../onboard/preflight.js";
import { resolveOpenshell } from "./openshell-resolver.js";
import {
  type CollectPlatformIdentityOptions,
  collectPlatformIdentity,
  type PlatformIdentity,
  projectPlatformQualification,
} from "./platform-qualification.js";
import { measureObservationAge, staleEvidence } from "./observation-age.js";
import { buildSystemReadinessProbeEnv, createSystemReadinessCapture } from "./probe-env.js";
import { sanitizeReadinessText } from "./sanitize.js";
import {
  type EvidenceScalar,
  type FindingSeverity,
  type ReadinessCapability,
  type ReadinessEvidence,
  type ReadinessFinding,
  type ReadinessObservation,
  type ReadinessState,
  SYSTEM_READINESS_SCHEMA_VERSION,
  type SystemReadinessReport,
} from "./types.js";

const DEFAULT_MAX_AGE_MS = 30_000;
const MAX_REPORT_TEXT_LENGTH = 1024;

export interface HostObservations {
  platform: string;
  architecture: string;
  isWsl: boolean;
  isHeadlessLikely: boolean;
  dockerInstalled: boolean;
  dockerReachable: boolean;
  dockerHostInvalid: boolean;
  runtime: string;
  dockerCgroupVersion?: string;
  dockerDefaultCgroupnsMode?: string;
  dockerStorageDriver?: string;
  dockerUsesContainerdSnapshotter?: boolean;
  dockerNvidiaRuntimeAvailable?: boolean;
  dockerCpus?: number;
  dockerMemTotalBytes?: number;
  isContainerRuntimeUnderProvisioned: boolean;
  hasNestedOverlayConflict: boolean;
  isUnsupportedRuntime: boolean;
  nodeInstalled: boolean;
  openshellInstalled: boolean;
  hasNvidiaGpu: boolean;
  nvidiaGpuCount?: number;
  nvidiaDriverVersion?: string;
  nvidiaGpuMemoryTotalBytes?: number;
  nvidiaGpuMemoryAvailableBytes?: number;
  nvidiaGpuMemoryPerDeviceBytes?: number;
  nvidiaGpuUnifiedMemory?: boolean;
  nvidiaGpuComputeConstrained?: boolean;
  hostGpuPlatform?: NvidiaPlatform;
  nvidiaContainerToolkitInstalled: boolean;
  dockerCdiSpecDirs: readonly string[];
  cdiNvidiaGpuSpecMissing: boolean;
  cdiNvidiaGpuSpecStale?: boolean;
  cdiNvidiaGpuSpecNeedsRepair?: boolean;
  platformIdentity?: PlatformIdentity;
}

export interface HostObservationSnapshot {
  observedAt: string;
  completedAt: string;
  observations?: Readonly<HostObservations>;
  failure?: string;
}

export interface CollectHostObservationsOptions {
  assess?: () => HostAssessment;
  architecture?: string;
  detectGpu?: () =>
    | (Pick<GpuDetection, "count" | "wslDockerDesktopGpuProofPassed"> &
        Partial<
          Pick<
            GpuDetection,
            | "platform"
            | "type"
            | "gpus"
            | "totalMemoryMB"
            | "availableMemoryMB"
            | "perGpuMB"
            | "unifiedMemory"
            | "computeConstrained"
          >
        >)
    | null;
  detectNvidiaDriverVersion?: () => string | undefined;
  detectHostGpuPlatform?: () => NvidiaPlatform;
  wslDockerDesktopGpuProofPassed?: boolean;
  collectPlatformIdentity?: () => PlatformIdentity;
  platformIdentityOptions?: CollectPlatformIdentityOptions;
  now?: () => Date;
}

export interface CreateHostReadinessReportOptions {
  nemoclawVersion: string;
  sourceRevision: string;
  now?: () => Date;
  maxObservationAgeMs?: number;
}

function safeReportText(value: string): string {
  return sanitizeReadinessText(value, MAX_REPORT_TEXT_LENGTH);
}

function adaptHostAssessment(
  host: Readonly<HostAssessment>,
  architecture: string,
  hasNvidiaGpu: boolean,
  hostGpuPlatform?: NvidiaPlatform,
  nvidiaGpuCount?: number,
  nvidiaDriverVersion?: string,
  gpu?: ReturnType<NonNullable<CollectHostObservationsOptions["detectGpu"]>>,
  platformIdentity?: PlatformIdentity,
  wslDockerDesktopGpuProofPassed?: boolean,
): HostObservations {
  return {
    platform: host.platform,
    architecture,
    isWsl: host.isWsl,
    isHeadlessLikely: host.isHeadlessLikely,
    dockerInstalled: host.dockerInstalled,
    dockerReachable: host.dockerReachable,
    dockerHostInvalid: host.dockerHostInvalid === true,
    runtime: host.runtime,
    dockerCgroupVersion: host.dockerCgroupVersion,
    dockerDefaultCgroupnsMode: host.dockerDefaultCgroupnsMode,
    dockerStorageDriver: host.dockerStorageDriver,
    dockerUsesContainerdSnapshotter: host.dockerUsesContainerdSnapshotter,
    dockerNvidiaRuntimeAvailable: host.dockerNvidiaRuntimeAvailable,
    dockerCpus: host.dockerCpus,
    dockerMemTotalBytes: host.dockerMemTotalBytes,
    isContainerRuntimeUnderProvisioned: host.isContainerRuntimeUnderProvisioned,
    hasNestedOverlayConflict: host.hasNestedOverlayConflict,
    isUnsupportedRuntime: host.isUnsupportedRuntime,
    nodeInstalled: host.nodeInstalled,
    openshellInstalled: host.openshellInstalled,
    hasNvidiaGpu,
    nvidiaGpuCount,
    nvidiaDriverVersion,
    nvidiaGpuMemoryTotalBytes:
      gpu?.totalMemoryMB === undefined ? undefined : gpu.totalMemoryMB * 1024 * 1024,
    nvidiaGpuMemoryAvailableBytes:
      gpu?.availableMemoryMB === undefined ? undefined : gpu.availableMemoryMB * 1024 * 1024,
    nvidiaGpuMemoryPerDeviceBytes:
      gpu?.gpus?.length
        ? Math.min(...gpu.gpus.map(({ memoryMB }) => memoryMB)) * 1024 * 1024
        : gpu?.perGpuMB === undefined
          ? undefined
          : gpu.perGpuMB * 1024 * 1024,
    nvidiaGpuUnifiedMemory: gpu?.unifiedMemory,
    nvidiaGpuComputeConstrained: gpu?.computeConstrained,
    hostGpuPlatform,
    nvidiaContainerToolkitInstalled: host.nvidiaContainerToolkitInstalled,
    dockerCdiSpecDirs: [...host.dockerCdiSpecDirs],
    cdiNvidiaGpuSpecMissing: host.cdiNvidiaGpuSpecMissing,
    cdiNvidiaGpuSpecStale: host.cdiNvidiaGpuSpecStale,
    cdiNvidiaGpuSpecNeedsRepair: host.cdiNvidiaGpuSpecNeedsRepair,
    platformIdentity: platformIdentity
      ? { ...platformIdentity, wslDockerDesktopGpuProofPassed }
      : { wslDockerDesktopGpuProofPassed },
  };
}

/** Stamp the completion of a collection so its own duration cannot age it out. */
export function collectHostObservations(
  options: CollectHostObservationsOptions = {},
): HostObservationSnapshot {
  const now = options.now ?? (() => new Date());
  const observed = observeHost(options, now().toISOString());
  return { ...observed, completedAt: now().toISOString() };
}

function observeHost(
  options: CollectHostObservationsOptions,
  observedAt: string,
): Omit<HostObservationSnapshot, "completedAt"> {
  try {
    const probeEnv = buildSystemReadinessProbeEnv();
    const runCaptureImpl = createSystemReadinessCapture(probeEnv);
    const resolveReadinessOpenshell = () => {
      const commandVResult = runCaptureImpl(["sh", "-c", 'command -v "$1"', "--", "openshell"], {
        ignoreError: true,
      });
      return resolveOpenshell({
        commandVResult: commandVResult || null,
        home: probeEnv.HOME,
      });
    };
    const assessment = options.assess
      ? options.assess()
      : assessHost({
          env: process.env,
          resolveOpenshellImpl: resolveReadinessOpenshell,
          runCaptureImpl,
        });
    const gpuProbeAllowed =
      !assessment.isWsl || assessment.runtime !== "docker-desktop" || assessment.dockerReachable;
    // Public readiness collection is observation-only. In particular, the
    // ARM64 WSL Docker Desktop accept path must not pull or start the bounded
    // CUDA proof container while producing a `mutated: false` report. The
    // onboarding admission path runs that proof explicitly after host and
    // gateway readiness have both admitted the run.
    const gpu = gpuProbeAllowed
      ? options.detectGpu
        ? options.detectGpu()
        : detectGpu({ proveArm64WslDockerDesktopGpu: null, runCaptureImpl })
      : null;
    const hasNvidiaGpu =
      assessment.hasNvidiaGpu || gpu?.type === "nvidia" || gpu?.platform === "jetson";
    const wslDockerDesktopGpuProofPassed =
      options.wslDockerDesktopGpuProofPassed ??
      (assessment.isWsl &&
      assessment.runtime === "docker-desktop" &&
      assessment.dockerReachable &&
      hasNvidiaGpu
        ? gpu?.wslDockerDesktopGpuProofPassed
        : undefined);
    return {
      observedAt,
      observations: adaptHostAssessment(
        assessment,
        options.architecture ?? process.arch,
        hasNvidiaGpu,
        hasNvidiaGpu
          ? (gpu?.platform ?? (options.detectHostGpuPlatform ?? detectNvidiaPlatform)())
          : undefined,
        gpu?.count,
        hasNvidiaGpu
          ? options.detectNvidiaDriverVersion
            ? options.detectNvidiaDriverVersion()
            : detectNvidiaDriverVersion({ runCaptureImpl })
          : undefined,
        gpu,
        (
          options.collectPlatformIdentity ??
          (() =>
            collectPlatformIdentity({
              ...options.platformIdentityOptions,
              isWsl: assessment.isWsl,
              runCaptureImpl,
            }))
        )(),
        wslDockerDesktopGpuProofPassed,
      ),
    };
  } catch (error) {
    return {
      observedAt,
      failure: safeReportText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function observation(id: string, value: EvidenceScalar | undefined): ReadinessObservation {
  if (value === undefined || value === null || value === "unknown") return { id, state: "unknown" };
  if (typeof value === "boolean") return { id, state: value ? "present" : "absent", value };
  if (typeof value === "string") return { id, state: "present", value: safeReportText(value) };
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
    "host.docker.host_invalid",
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
    "host.gpu.count",
    "host.gpu.driver_version",
    "host.gpu.memory_total_bytes",
    "host.gpu.memory_available_bytes",
    "host.gpu.memory_per_device_bytes",
    "host.gpu.unified_memory",
    "host.gpu.compute_constrained",
    "host.gpu.container_toolkit",
    "host.gpu.nvidia_runtime",
    "host.gpu.cdi",
    "host.gpu.cdi_stale",
  ];
  const capabilityIds = [
    "host.docker.available",
    "host.docker.daemon_reachable",
    "host.docker.endpoint_supported",
    "host.docker.runtime_supported",
    "host.docker.resources_sufficient",
    "host.docker.storage_compatible",
    "host.docker.storage_remediation_available",
    "host.toolchain.node_available",
    "host.toolchain.openshell_available",
    "host.gpu.nvidia_available",
    "host.gpu.container_toolkit_available",
    "host.gpu.cdi_healthy",
    "host.platform.supported",
    "host.platform.linux_supported",
    "host.platform.macos_apple_silicon",
    "host.platform.wsl_docker_desktop",
    "host.platform.wsl_native_docker",
    "host.platform.wsl_runtime_available",
    "host.platform.wsl_gpu_passthrough",
    "host.platform.n1x_wsl",
    "host.platform.dgx_spark",
    "host.platform.n1x",
    "host.platform.dgx_station",
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
  const unsafeReuse = measureObservationAge(
    snapshot.completedAt,
    now,
    options.maxObservationAgeMs ?? DEFAULT_MAX_AGE_MS,
  );
  const evidence: ReadinessEvidence[] = [];
  if (snapshot.failure) {
    evidence.push({ id: "host.probe.failure", summary: safeReportText(snapshot.failure) });
  }
  if (unsafeReuse) {
    evidence.push(staleEvidence("host.probe.stale", "Host", snapshot.completedAt, unsafeReuse));
  }

  let observations: ReadinessObservation[];
  let capabilities: ReadinessCapability[];
  let qualifications: SystemReadinessReport["qualifications"] = [];
  let findings: ReadinessFinding[];
  const host = snapshot.observations;
  if (!host || snapshot.failure || unsafeReuse) {
    const projected = unknownProjection(evidence.map(({ id }) => id));
    ({ observations, capabilities, findings } = projected);
  } else {
    const dockerHostBlocks = host.dockerHostInvalid;
    const dockerEvidenceUsable = host.dockerReachable && !dockerHostBlocks;
    const cdiApplies =
      host.platform === "linux" &&
      dockerEvidenceUsable &&
      host.hasNvidiaGpu &&
      host.dockerCdiSpecDirs.length > 0 &&
      host.hostGpuPlatform !== "jetson" &&
      !(host.isWsl && host.runtime === "docker-desktop");
    const containerToolkitApplies =
      host.hasNvidiaGpu &&
      host.hostGpuPlatform !== "jetson" &&
      !(host.isWsl && host.runtime === "docker-desktop");
    const jetsonRuntimeApplies =
      dockerEvidenceUsable && host.hasNvidiaGpu && host.hostGpuPlatform === "jetson";
    const cdiHealthy =
      !cdiApplies ||
      (!host.cdiNvidiaGpuSpecMissing &&
        !host.cdiNvidiaGpuSpecStale &&
        !host.cdiNvidiaGpuSpecNeedsRepair);
    const storageRemediationAvailable =
      host.platform === "linux" &&
      !host.isWsl &&
      dockerEvidenceUsable &&
      host.runtime === "docker" &&
      host.hasNestedOverlayConflict &&
      host.dockerStorageDriver === "overlayfs" &&
      host.dockerUsesContainerdSnapshotter === true;
    observations = [
      observation("host.os.platform", host.platform),
      observation("host.os.architecture", host.architecture),
      observation("host.os.wsl", host.isWsl),
      observation("host.session.headless", host.isHeadlessLikely),
      observation("host.docker.installed", host.dockerInstalled),
      observation("host.docker.reachable", dockerHostBlocks ? undefined : host.dockerReachable),
      observation("host.docker.host_invalid", host.dockerHostInvalid),
      observation("host.docker.runtime", dockerEvidenceUsable ? host.runtime : undefined),
      observation("host.docker.cpus", dockerEvidenceUsable ? host.dockerCpus : undefined),
      observation(
        "host.docker.memory_bytes",
        dockerEvidenceUsable ? host.dockerMemTotalBytes : undefined,
      ),
      observation(
        "host.docker.cgroup_version",
        dockerEvidenceUsable ? host.dockerCgroupVersion : undefined,
      ),
      observation(
        "host.docker.cgroupns_mode",
        dockerEvidenceUsable ? host.dockerDefaultCgroupnsMode : undefined,
      ),
      observation(
        "host.docker.storage_driver",
        dockerEvidenceUsable ? host.dockerStorageDriver : undefined,
      ),
      observation(
        "host.docker.containerd_snapshotter",
        dockerEvidenceUsable ? host.dockerUsesContainerdSnapshotter : undefined,
      ),
      observation("host.toolchain.node", host.nodeInstalled),
      observation("host.toolchain.openshell", host.openshellInstalled),
      observation("host.gpu.nvidia", host.hasNvidiaGpu),
      observation("host.gpu.count", host.hasNvidiaGpu ? host.nvidiaGpuCount : undefined),
      observation(
        "host.gpu.driver_version",
        host.hasNvidiaGpu ? host.nvidiaDriverVersion : undefined,
      ),
      observation(
        "host.gpu.memory_total_bytes",
        host.hasNvidiaGpu ? host.nvidiaGpuMemoryTotalBytes : undefined,
      ),
      observation(
        "host.gpu.memory_available_bytes",
        host.hasNvidiaGpu ? host.nvidiaGpuMemoryAvailableBytes : undefined,
      ),
      observation(
        "host.gpu.memory_per_device_bytes",
        host.hasNvidiaGpu ? host.nvidiaGpuMemoryPerDeviceBytes : undefined,
      ),
      observation(
        "host.gpu.unified_memory",
        host.hasNvidiaGpu ? host.nvidiaGpuUnifiedMemory : undefined,
      ),
      observation(
        "host.gpu.compute_constrained",
        host.hasNvidiaGpu ? host.nvidiaGpuComputeConstrained : undefined,
      ),
      observation(
        "host.gpu.container_toolkit",
        host.hasNvidiaGpu ? host.nvidiaContainerToolkitInstalled : false,
      ),
      observation(
        "host.gpu.nvidia_runtime",
        jetsonRuntimeApplies ? host.dockerNvidiaRuntimeAvailable : false,
      ),
      observation("host.gpu.cdi", cdiApplies ? cdiHealthy : false),
      observation("host.gpu.cdi_stale", cdiApplies ? host.cdiNvidiaGpuSpecStale : false),
    ];
    const platform = projectPlatformQualification({
      platform: host.platform,
      architecture: host.architecture,
      isWsl: host.isWsl,
      dockerInstalled: host.dockerInstalled,
      dockerReachable: dockerEvidenceUsable,
      runtime: host.runtime,
      hasNvidiaGpu: host.hasNvidiaGpu,
      ...host.platformIdentity,
    });
    evidence.push(...platform.evidence);
    qualifications = platform.qualifications;
    capabilities = [
      ...platform.capabilities,
      capability("host.docker.available", stateOf(host.dockerInstalled)),
      capability("host.docker.endpoint_supported", stateOf(!host.dockerHostInvalid)),
      capability(
        "host.docker.daemon_reachable",
        dockerHostBlocks
          ? "unknown"
          : host.dockerInstalled
            ? stateOf(host.dockerReachable)
            : "absent",
      ),
      capability(
        "host.docker.runtime_supported",
        dockerEvidenceUsable ? stateOf(!host.isUnsupportedRuntime) : "unknown",
      ),
      capability(
        "host.docker.resources_sufficient",
        dockerEvidenceUsable ? stateOf(!host.isContainerRuntimeUnderProvisioned) : "unknown",
      ),
      capability(
        "host.docker.storage_compatible",
        dockerEvidenceUsable ? stateOf(!host.hasNestedOverlayConflict) : "unknown",
      ),
      capability(
        "host.docker.storage_remediation_available",
        dockerEvidenceUsable ? stateOf(storageRemediationAvailable) : "unknown",
      ),
      capability("host.toolchain.node_available", stateOf(host.nodeInstalled)),
      capability("host.toolchain.openshell_available", stateOf(host.openshellInstalled)),
      capability("host.gpu.nvidia_available", stateOf(host.hasNvidiaGpu)),
      capability(
        "host.gpu.container_toolkit_available",
        jetsonRuntimeApplies
          ? stateOf(host.dockerNvidiaRuntimeAvailable)
          : containerToolkitApplies
            ? stateOf(host.nvidiaContainerToolkitInstalled)
            : "present",
      ),
      capability("host.gpu.cdi_healthy", cdiApplies ? stateOf(cdiHealthy) : "present"),
    ];
    findings = [...platform.findings];
    if (!host.dockerInstalled)
      findings.push(
        finding("host.docker.unavailable", "blocking", "Docker is not installed.", [
          "host.docker.available",
        ]),
      );
    if (dockerHostBlocks)
      findings.push(
        finding(
          "host.docker.host_invalid",
          "blocking",
          "DOCKER_HOST is not a supported absolute local Unix socket endpoint.",
          ["host.docker.endpoint_supported"],
        ),
      );
    else if (host.dockerInstalled && !host.dockerReachable)
      findings.push(
        finding("host.docker.daemon_unreachable", "blocking", "The Docker daemon is unreachable.", [
          "host.docker.daemon_reachable",
        ]),
      );
    if (dockerEvidenceUsable && host.isContainerRuntimeUnderProvisioned)
      findings.push(
        finding(
          "host.docker.resources_insufficient",
          "warning",
          "Container runtime resources are below recommendations.",
          ["host.docker.resources_sufficient"],
        ),
      );
    if (dockerEvidenceUsable && host.isUnsupportedRuntime)
      findings.push(
        finding(
          "host.docker.runtime_unsupported",
          "blocking",
          "The detected container runtime is unsupported.",
          ["host.docker.runtime_supported"],
        ),
      );
    if (dockerEvidenceUsable && host.hasNestedOverlayConflict)
      findings.push(
        finding(
          "host.docker.storage_incompatible",
          "blocking",
          "The Docker storage configuration cannot support nested overlay mounts.",
          ["host.docker.storage_compatible"],
        ),
      );
    if (containerToolkitApplies && !host.nvidiaContainerToolkitInstalled)
      findings.push(
        finding(
          "host.gpu.container_toolkit_missing",
          "blocking",
          "NVIDIA Container Toolkit is missing.",
          ["host.gpu.container_toolkit_available"],
        ),
      );
    if (jetsonRuntimeApplies && host.dockerNvidiaRuntimeAvailable === false)
      findings.push(
        finding(
          "host.gpu.nvidia_runtime_missing",
          "blocking",
          "Docker NVIDIA runtime support is missing for Jetson/Tegra sandbox GPU.",
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
  const outcome = hasBlocking
    ? ({ status: "incompatible", exitCode: 2 } as const)
    : hasUnknown
      ? ({ status: "inconclusive", exitCode: 3 } as const)
      : ({ status: "supported", exitCode: 0 } as const);
  return {
    schemaVersion: SYSTEM_READINESS_SCHEMA_VERSION,
    ...outcome,
    mutated: false,
    provenance: {
      nemoclawVersion: options.nemoclawVersion,
      sourceRevision: options.sourceRevision,
      observedAt: snapshot.observedAt,
    },
    observations,
    capabilities,
    qualifications,
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
