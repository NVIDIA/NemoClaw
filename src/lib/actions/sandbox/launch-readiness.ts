// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import type { AgentDefinition } from "../../agent/defs";
import { log } from "../../cli/logger";
import { parseGatewayInference, planInferenceRouteReconcile } from "../../inference/config";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { normalizeInferenceSelection } from "../../inference/selection";
import { parseServingProfileProvenance } from "../../inference/serving/profile-provenance";
import { resolveGatewayName } from "../../onboard/gateway-binding";
import {
  classifyPortableLifecycleReceipt,
  portableLifecycleReceiptMatchesGeneration,
  type PortableLifecycleReceiptClassification,
} from "../../onboard/experimental/portable-runtime-receipt-readiness";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
} from "../../onboard/sandbox-recreate-probe";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { parseAndValidateSandboxPolicy } from "../../policy/sandbox-policy-validation";
import {
  checkLaunchReadinessMutationAuthority,
  fenceLaunchReadinessLease,
  type LaunchReadinessFence,
  LaunchReadinessFenceError,
  type LaunchReadinessIdentity,
  type LaunchReadinessLeaseRead,
  type LaunchReadinessStoreOptions,
  publishLaunchReadinessLease,
  readLaunchReadinessLease,
} from "../../state/launch-readiness-lease";
import { withMcpLifecycleLock as withSandboxMutationLock } from "../../state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry";
import * as registry from "../../state/registry";
import { normalizeSandboxMcpState } from "../../state/registry-mcp";
import {
  cloneSandboxMessagingState,
  serializeSandboxMessagingStateForDisk,
} from "../../state/registry-messaging";
import { buildGatewayInferenceGetArgs } from "./connect-inference-gateway";
import {
  runPortableOpenClawPairingApproval,
  runPortableOpenClawPairingRequestProducer,
} from "./auto-pair-approval";
import {
  captureLaunchReadiness,
  createBoundLaunchReadinessDeps,
  LaunchReadinessEvidenceError,
  type LaunchReadinessFailedCheck,
  type LaunchReadinessHealthDeps,
  type LaunchReadinessObservationStage,
  LaunchReadinessObservationError as ObservationError,
  recordLaunchReadinessObservationFailure,
  requireLaunchSemanticHealth,
  resolveLaunchInteractiveCommand,
  resolveTrustedLaunchAgent,
} from "./launch-readiness/health";
import {
  observeOpenClawPairingQualification,
  observeOpenClawPairingRepairSettlement,
  observeOpenClawPairingSettlement,
  OpenClawPairingObservationRetryableError,
  OpenClawPairingQualificationError,
  OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_POLL_MS,
  OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
  type OpenClawPairingRepairObservation,
  type OpenClawPairingSettlementObservation,
} from "./launch-readiness/openclaw-pairing-qualification";

export { createProbeTimingRecorder, type ProbeTimingRecorder } from "./probe/timing";
export { createBoundLaunchReadinessDeps };

const LIVE_POLICY_MAX_BYTES = 2 * 1_024 * 1_024;
const ALLOWED_OPENSHELL_DRIVERS = new Set(["docker", "kubernetes", "vm"]);

export type LaunchReadinessPerformanceStage =
  | "storage-read"
  | "live-validation"
  | "evidence-fence"
  | "publication-validation"
  | "publication-store";

export type LaunchReadinessDecisionCategory =
  | "accepted"
  | "missing"
  | "unsafe"
  | "malformed"
  | "expired"
  | "identity"
  | "config"
  | "health"
  | "session";

export type LaunchReadinessDecision =
  | {
      kind: "accepted";
      category: "accepted";
      agent: AgentDefinition;
      sb: SandboxEntry;
    }
  | {
      kind: "fallback";
      category: Exclude<LaunchReadinessDecisionCategory, "accepted">;
      fence: LaunchReadinessFence | null;
      gatewayName: string | null;
      gatewayPort: number | null;
      fenceFailed: boolean;
      recoveryBlocked: boolean;
      authorityUnsupported?: true;
    };

export interface LaunchReadinessDeps extends LaunchReadinessHealthDeps {
  checkMutationAuthority?: typeof checkLaunchReadinessMutationAuthority;
  getSandbox?: typeof registry.getSandbox;
  updateSandbox?: typeof registry.updateSandbox;
  observeSandbox?: SandboxRecreateObserver;
  readLease?: typeof readLaunchReadinessLease;
  fenceLease?: typeof fenceLaunchReadinessLease;
  publishLease?: typeof publishLaunchReadinessLease;
  observeOpenClawPairingQualification?: typeof observeOpenClawPairingQualification;
  observeOpenClawPairingRepairSettlement?: typeof observeOpenClawPairingRepairSettlement;
  observeOpenClawPairingSettlement?: typeof observeOpenClawPairingSettlement;
  runPortablePairingProducer?: typeof runPortableOpenClawPairingRequestProducer;
  runPortablePairingApproval?: typeof runPortableOpenClawPairingApproval;
  classifyPortableLifecycleReceipt?: typeof classifyPortableLifecycleReceipt;
  storeOptions?: LaunchReadinessStoreOptions;
  withSandboxLock?: typeof withSandboxMutationLock;
  withGatewayLock?: typeof withGatewayRouteMutationLock;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface LaunchReadinessPublication {
  sandboxName: string;
  gatewayName: string | null;
  gatewayPort: number | null;
  epochId: string | null;
}

export type LaunchReadinessPublicationResult =
  | { kind: "published" }
  | {
      kind: "validation-failed";
      category: "identity" | "config" | "health" | "session";
      failedCheck?: LaunchReadinessFailedCheck;
    }
  | { kind: "evidence-failed" };

export type LaunchReadinessMutationGateResult<T> =
  | { kind: "entered"; value: T }
  | { kind: "changed" }
  | { kind: "unsafe" };

export type PortableOpenClawPairingSettlementResult =
  | { readonly kind: "not-portable" }
  | { readonly kind: "settled" }
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "portable-receipt-missing"
        | "portable-receipt-invalid"
        | "portable-policy-incomplete"
        | "portable-runtime-identity-invalid"
        | "portable-pairing-incomplete";
    };

export interface OpenClawPairingSettlementTarget {
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly stateDirectory: string;
  readonly version: string;
}

type LaunchReadinessPublicationValidationCategory = Extract<
  LaunchReadinessPublicationResult,
  { kind: "validation-failed" }
>["category"];

function recordPerformanceStage(stage: LaunchReadinessPerformanceStage, startedAt: number): void {
  try {
    performance.measure(`nemoclaw.launch-readiness.${stage}`, {
      start: startedAt,
      end: performance.now(),
    });
  } catch {
    // Measurements are diagnostic evidence and never control launch behavior.
  }
}

function recordObservationTiming(
  deps: LaunchReadinessDeps,
  stage: LaunchReadinessObservationStage,
  startedAt: number,
): void {
  try {
    deps.recordObservationTiming?.(stage, Math.max(0, performance.now() - startedAt));
  } catch {
    // Timing evidence must never change readiness behavior.
  }
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function exactNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new ObservationError("config");
}

export function launchReadinessDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactContentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function projectHostMounts(entry: SandboxEntry): unknown[] {
  return (entry.hostMounts ?? []).map((mount) => {
    const source = exactNonemptyString(mount.source);
    const target = exactNonemptyString(mount.target);
    const device = exactNonemptyString(mount.sourceIdentity?.device);
    const inode = exactNonemptyString(mount.sourceIdentity?.inode);
    if (!source || !target || mount.readOnly !== true || !device || !inode) {
      throw new ObservationError("config");
    }
    return {
      sourceSha256: exactContentDigest(source),
      target,
      readOnly: true,
      sourceIdentity: { device, inode },
    };
  });
}

function projectServingProfile(entry: SandboxEntry): unknown {
  if (entry.servingProfileProvenance === undefined) return null;
  const provenance = parseServingProfileProvenance(entry.servingProfileProvenance);
  if (!provenance) throw new ObservationError("config");
  return {
    schemaVersion: provenance.schemaVersion,
    catalogDigest: provenance.catalogDigest,
    preset: {
      id: provenance.preset.id,
      digest: provenance.preset.digest,
      displayName: provenance.preset.displayName,
      supportState: provenance.preset.supportState,
    },
    recipe: {
      id: provenance.recipe.id,
      digest: provenance.recipe.digest,
      backend: provenance.recipe.backend,
    },
    model: {
      id: provenance.model.id,
      revision: provenance.model.revision,
    },
    runtimeImage: provenance.runtimeImage,
    estimatedImageDownloadBytes: provenance.estimatedImageDownloadBytes,
    estimatedModelDownloadBytes: provenance.estimatedModelDownloadBytes,
  };
}

function projectOptionalBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ObservationError("config");
  return value;
}

function projectWorkload(workload: SandboxWorkloadReceipt | undefined): unknown {
  if (!workload) return null;
  if (workload.kind === "legacy-dockerfile") {
    return {
      schemaVersion: workload.schemaVersion,
      kind: workload.kind,
      reference: workload.reference,
      shared: workload.shared,
    };
  }
  if (workload.kind === "managed-image") {
    return {
      schemaVersion: workload.schemaVersion,
      kind: workload.kind,
      reference: workload.reference,
      platform: workload.platform ?? null,
      release: workload.release,
      sourceRevision: workload.sourceRevision,
      sourceCohort: workload.sourceCohort,
      capabilityContractVersion: workload.capabilityContractVersion,
      startupProfileContractVersion: workload.startupProfileContractVersion,
      startupProfileSha256: workload.startupProfileSha256,
      credentialProxyReplayRequired: workload.credentialProxyReplayRequired,
      corporateCaSha256: workload.corporateCaB64
        ? exactContentDigest(workload.corporateCaB64)
        : null,
      shared: workload.shared,
    };
  }
  return {
    schemaVersion: workload.schemaVersion,
    kind: workload.kind,
    contractVersion: workload.contractVersion,
    agent: workload.agent,
    platform: workload.platform,
    artifact: {
      digest: workload.artifact.digest,
      version: workload.artifact.version,
      sourceRepository: workload.artifact.source.repository,
      sourceRevision: workload.artifact.source.revision,
    },
    launch: {
      executableRelativePath: workload.launch.executable.relativePath,
      executableDigest: workload.launch.executable.digest,
      arguments: [...workload.launch.arguments],
      workingDirectory: workload.launch.workingDirectory,
      environmentNames: [...workload.launch.environmentNames],
    },
    startupProfileContractVersion: workload.startupProfileContractVersion,
    startupProfileSha256: workload.startupProfileSha256,
    credentialProxyReplayRequired: workload.credentialProxyReplayRequired,
    shared: workload.shared,
  };
}

function projectMcpState(value: unknown): unknown {
  const state = normalizeSandboxMcpState(value);
  if (!state) return null;
  if (state.destroyPreparedAt || state.destroyPendingAt) throw new ObservationError("config");
  return {
    bridges: Object.values(state.bridges)
      .map((bridge) => {
        if (bridge.addState) throw new ObservationError("config");
        const endpoint = new URL(bridge.url);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new ObservationError("config");
        }
        return {
          server: bridge.server,
          agent: bridge.agent,
          adapter: bridge.adapter ?? null,
          url: bridge.url,
          env: [...bridge.env],
          trustedPrivateHost: bridge.trustedPrivateHost ?? null,
          allowedIps: bridge.allowedIps ? [...bridge.allowedIps] : null,
          providerName: bridge.providerName ?? null,
          providerId: bridge.providerId ?? null,
          policyName: bridge.policyName,
        };
      })
      .sort((left, right) => left.server.localeCompare(right.server)),
    managedServerNames: [...(state.managedServerNames ?? [])].sort(),
  };
}

function projectMessagingState(entry: SandboxEntry): unknown {
  const state = cloneSandboxMessagingState(entry.messaging);
  const persisted = serializeSandboxMessagingStateForDisk(entry.messaging);
  if (!state || !persisted) return null;
  const originalChannels = new Map(
    state.plan.channels.map((channel) => [channel.channelId, channel]),
  );
  return {
    schemaVersion: persisted.schemaVersion,
    plan: {
      schemaVersion: persisted.plan.schemaVersion,
      sandboxName: persisted.plan.sandboxName,
      agent: persisted.plan.agent,
      workflow: persisted.plan.workflow,
      disabledChannels: [...persisted.plan.disabledChannels],
      channels: persisted.plan.channels.map((channel) => {
        const originalInputs = new Map(
          (originalChannels.get(channel.channelId)?.inputs ?? []).map((input) => [
            input.inputId,
            input,
          ]),
        );
        return {
          channelId: channel.channelId,
          active: channel.active ?? null,
          configured: channel.configured,
          disabled: channel.disabled,
          inputs: (channel.inputs ?? []).map((input) => ({
            inputId: input.inputId,
            credentialAvailable: input.credentialAvailable ?? null,
            value:
              originalInputs.get(input.inputId)?.kind === "config" ? (input.value ?? null) : null,
          })),
          hooks: channel.hooks ?? [],
        };
      }),
      credentialBindings: (persisted.plan.credentialBindings ?? []).map((binding) => ({
        channelId: binding.channelId,
        providerEnvKey: binding.providerEnvKey,
        credentialAvailable: binding.credentialAvailable,
      })),
    },
  };
}

function projectAgent(agent: AgentDefinition): unknown {
  let manifestSha256: string;
  try {
    manifestSha256 = exactContentDigest(fs.readFileSync(agent.manifestPath, "utf8"));
  } catch {
    throw new LaunchReadinessEvidenceError();
  }
  return {
    version: 1,
    manifestSha256,
    name: agent.name,
    binaryPath: agent.binary_path ?? null,
    versionCommand: agent.versionCommand,
    expectedVersion: agent.expectedVersion,
    versionScheme: agent.versionScheme ?? null,
    gatewayCommand: agent.gateway_command ?? null,
    runtime: {
      kind: agent.runtime?.kind ?? "gateway",
      interactiveCommand: agent.runtime?.interactive_command ?? null,
      headlessCommand: agent.runtime?.headless_command ?? null,
      smokeCommands: [...(agent.runtime?.smoke_commands ?? [])],
    },
    forwardPorts: [...(agent.forward_ports ?? [])],
    devicePairing: agent.hasDevicePairing,
    phoneHomeHosts: [...agent.phoneHomeHosts],
    healthProbe: agent.healthProbe
      ? {
          url: agent.healthProbe.url,
          port: agent.healthProbe.port,
          timeoutSeconds: agent.healthProbe.timeout_seconds,
        }
      : null,
    dashboard: {
      kind: agent.dashboard.kind,
      path: agent.dashboard.path,
      healthPath: agent.dashboard.healthPath,
      auth: agent.dashboard.auth,
    },
    webAuth: {
      method: agent.webAuth.method,
      env: agent.webAuth.env,
    },
    dashboardUi: agent.dashboardUi
      ? {
          label: agent.dashboardUi.label,
          port: agent.dashboardUi.port,
          path: agent.dashboardUi.path,
          enableEnv: agent.dashboardUi.enableEnv,
          portEnv: agent.dashboardUi.portEnv,
          tuiEnv: agent.dashboardUi.tuiEnv,
        }
      : null,
    configPaths: {
      dir: agent.configPaths.dir,
      configFile: agent.configPaths.configFile,
      envFile: agent.configPaths.envFile,
      format: agent.configPaths.format,
      shieldsFiles: [...agent.configPaths.shieldsFiles],
    },
    inference: {
      providerType: agent.inference?.provider_type ?? null,
      providerOptions: [...agent.inferenceProviderOptions],
      defaultModel: agent.inference?.default_model ?? null,
    },
    mcp: {
      support: agent.mcpCapability.support,
      adapter: agent.mcpCapability.adapter ?? null,
      reason: agent.mcpCapability.reason ?? null,
    },
    stateLockPlan: {
      version: agent.stateLockPlan.version,
      readOnlyRoots: [...agent.stateLockPlan.readOnlyRoots],
      confidentialRoots: [...agent.stateLockPlan.confidentialRoots],
      readOnlyPrefixes: [...agent.stateLockPlan.readOnlyPrefixes],
      confidentialPrefixes: [...agent.stateLockPlan.confidentialPrefixes],
      writableSubpaths: [...agent.stateLockPlan.writableSubpaths],
    },
    stateLockPlanInImage: agent.stateLockPlanInImage,
  };
}

export function buildLaunchReadinessRegistryProjection(
  entry: SandboxEntry,
  agent: AgentDefinition,
  portableRuntimeAuthoritySha256: string | null = null,
): unknown {
  const driver = normalizedString(entry.openshellDriver)?.toLowerCase() ?? null;
  if (!driver || !ALLOWED_OPENSHELL_DRIVERS.has(driver)) throw new ObservationError("config");
  const openshellVersion = normalizedString(entry.openshellVersion);
  const gatewayPort = entry.gatewayPort;
  if (!openshellVersion || openshellVersion.length > 128) throw new ObservationError("config");
  if (!Number.isInteger(gatewayPort) || (gatewayPort ?? 0) < 1 || (gatewayPort ?? 0) > 65535) {
    throw new ObservationError("config");
  }
  const gatewayName = resolveGatewayName(gatewayPort as number);
  if (entry.gatewayName !== gatewayName) throw new ObservationError("config");
  const lifecycleGeneration = normalizedString(entry.lifecycleGeneration);
  const liveIdentityFingerprint = normalizedString(entry.lifecycleLiveIdentityFingerprint);
  if (!lifecycleGeneration || !liveIdentityFingerprint) throw new ObservationError("identity");
  if (entry.pendingRouteReservation === true) {
    throw new ObservationError("config");
  }
  const inference = normalizeInferenceSelection(entry);
  if (
    inference.credentialEnv !== null &&
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(inference.credentialEnv)
  ) {
    throw new ObservationError("config");
  }
  if (inference.endpointUrl !== null) {
    let endpoint: URL;
    try {
      endpoint = new URL(inference.endpointUrl);
    } catch {
      throw new ObservationError("config");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new ObservationError("config");
    }
  }
  const agentName = normalizedString(entry.agent) ?? "openclaw";
  const interactiveCommand = resolveLaunchInteractiveCommand(agent, agentName);
  const sandboxGpuMode = entry.sandboxGpuMode ?? null;
  const sandboxGpuDevice = entry.sandboxGpuDevice ?? null;
  if (sandboxGpuMode !== null && typeof sandboxGpuMode !== "string") {
    throw new ObservationError("config");
  }
  if (sandboxGpuDevice !== null && typeof sandboxGpuDevice !== "string") {
    throw new ObservationError("config");
  }
  const hermesAuthMethod = entry.hermesAuthMethod ?? null;
  if (hermesAuthMethod !== null && hermesAuthMethod !== "oauth" && hermesAuthMethod !== "api_key") {
    throw new ObservationError("config");
  }
  if (
    portableRuntimeAuthoritySha256 !== null &&
    !/^[a-f0-9]{64}$/.test(portableRuntimeAuthoritySha256)
  ) {
    throw new ObservationError("config");
  }

  return {
    version: 2,
    name: entry.name,
    openshellDriver: driver,
    openshellVersion,
    gatewayName,
    gatewayPort,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
    agent: agentName,
    agentVersion: normalizedString(entry.agentVersion),
    nemoclawVersion: normalizedString(entry.nemoclawVersion),
    imageTag: normalizedString(entry.imageTag),
    workloadIdentitySha256: launchReadinessDigest(projectWorkload(entry.workload)),
    fromDockerfile: normalizedString(entry.fromDockerfile),
    servingProfileProvenance: projectServingProfile(entry),
    hostMounts: projectHostMounts(entry),
    gpuEnabled: projectOptionalBoolean(entry.gpuEnabled),
    hostGpuDetected: projectOptionalBoolean(entry.hostGpuDetected),
    sandboxGpuEnabled: projectOptionalBoolean(entry.sandboxGpuEnabled),
    sandboxGpuMode,
    sandboxGpuDevice,
    interactiveCommand,
    sandboxGpuProof: entry.sandboxGpuProof
      ? {
          status: entry.sandboxGpuProof.status,
          cudaVerified: entry.sandboxGpuProof.cudaVerified,
          label: entry.sandboxGpuProof.label ?? null,
        }
      : null,
    inference,
    ...(portableRuntimeAuthoritySha256
      ? {
          portableLifecycleReceipt: "current",
          portableRuntimeAuthoritySha256,
        }
      : {}),
    webSearchEnabled: entry.webSearchEnabled === true,
    webSearchProvider: entry.webSearchProvider ?? null,
    toolDisclosure: entry.toolDisclosure ?? null,
    observabilityEnabled: entry.observabilityEnabled === true,
    dcodeAutoApprovalMode: entry.dcodeAutoApprovalMode ?? null,
    messagingSha256: launchReadinessDigest(projectMessagingState(entry)),
    mcpSha256: launchReadinessDigest(projectMcpState(entry.mcp)),
    hermesToolGateways: [...(entry.hermesToolGateways ?? [])],
    hermesInferenceProvider: normalizedString(entry.hermesInferenceProvider),
    hermesAuthMethod,
    hermesDashboardEnabled: entry.hermesDashboardEnabled === true,
    hermesDashboardPort: entry.hermesDashboardPort ?? null,
    hermesDashboardInternalPort: entry.hermesDashboardInternalPort ?? null,
    hermesDashboardTui: entry.hermesDashboardTui === true,
    dashboardPort: entry.dashboardPort ?? null,
    dashboardRemoteBindPrepared: entry.dashboardRemoteBindPrepared === true,
    openclawImagePluginInstalls: (entry.openclawImagePluginInstalls ?? []).map((install) => ({
      id: install.id,
      installPath: install.installPath,
      loadPaths: install.loadPaths ? [...install.loadPaths] : null,
    })),
  };
}

function classifyReceipt(
  read: LaunchReadinessLeaseRead,
): Exclude<LaunchReadinessDecisionCategory, "accepted" | "health" | "session"> {
  return read.kind === "valid" ? "config" : read.kind;
}

function validateLivePolicy(
  sandboxName: string,
  gatewayName: string,
  deps: LaunchReadinessDeps,
): void {
  const result = (
    deps.capture ?? ((args) => captureLaunchReadiness(args, { maxBuffer: LIVE_POLICY_MAX_BYTES }))
  )(["policy", "get", "-g", gatewayName, "--full", sandboxName]);
  if (result.status !== 0 || !result.output?.trim()) throw new LaunchReadinessEvidenceError();
  try {
    parseAndValidateSandboxPolicy(result.output);
  } catch {
    throw new LaunchReadinessEvidenceError();
  }
}

function reportsInferenceNotConfigured(output: string): boolean {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  let inGatewayInference = false;
  for (const line of lines) {
    if (/^(?:Gateway )?Inference:\s*$/i.test(line)) {
      inGatewayInference = true;
      continue;
    }
    if (inGatewayInference && /^\S.*:$/.test(line)) return false;
    if (inGatewayInference && /^Not configured$/i.test(line.trim())) return true;
  }
  return false;
}

async function captureLaunchIdentity(
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  deps: LaunchReadinessDeps,
): Promise<{ identity: LaunchReadinessIdentity; agent: AgentDefinition; sb: SandboxEntry }> {
  try {
    assertNoOpenShellGatewayEndpointOverride();
  } catch {
    throw new ObservationError("config");
  }
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const entry = getSandbox(sandboxName);
  if (!entry || entry.name !== sandboxName) throw new ObservationError("identity");
  const agentName = normalizedString(entry.agent) ?? "openclaw";
  const agent = resolveTrustedLaunchAgent(entry, deps, agentName);
  const portableReceipt = (
    deps.classifyPortableLifecycleReceipt ?? classifyPortableLifecycleReceipt
  )(sandboxName);
  let portableRuntimeAuthoritySha256: string | null = null;
  if (entry.agent === "openclaw") {
    if (portableReceipt.kind === "invalid-or-legacy") throw new ObservationError("config");
    if (portableReceipt.kind === "current") {
      if (entry.lifecycleGeneration !== portableReceipt.registryGeneration) {
        throw new ObservationError("config");
      }
      portableRuntimeAuthoritySha256 = launchReadinessDigest(portableReceipt.runtimeAuthority);
    }
  } else if (
    portableReceipt.kind !== "absent" &&
    !(
      typeof entry.agent === "string" &&
      entry.agent.length > 0 &&
      entry.agent === entry.agent.trim() &&
      entry.agent !== "openclaw"
    )
  ) {
    throw new ObservationError("config");
  }
  const projection = buildLaunchReadinessRegistryProjection(
    entry,
    agent,
    portableRuntimeAuthoritySha256,
  );
  if (entry.gatewayPort !== gatewayPort || entry.gatewayName !== gatewayName) {
    throw new ObservationError("identity");
  }
  const lifecycleGeneration = normalizedString(entry.lifecycleGeneration);
  const recordedFingerprint = normalizedString(entry.lifecycleLiveIdentityFingerprint);
  if (!lifecycleGeneration || !recordedFingerprint) throw new ObservationError("identity");

  let live: ReturnType<SandboxRecreateObserver>;
  const sandboxIdentityStartedAt = performance.now();
  try {
    live = (deps.observeSandbox ?? observeSandboxOnGateway)({
      sandboxName,
      gatewayName,
      gatewayPort,
    });
  } catch {
    recordLaunchReadinessObservationFailure(deps, "sandbox-identity");
    throw new LaunchReadinessEvidenceError();
  } finally {
    recordObservationTiming(deps, "sandbox-identity", sandboxIdentityStartedAt);
  }
  if (live.state === "missing") {
    recordLaunchReadinessObservationFailure(deps, "sandbox-identity");
    throw new ObservationError("identity");
  }
  if (live.state !== "ready") {
    recordLaunchReadinessObservationFailure(deps, "sandbox-identity");
    throw new ObservationError("health");
  }
  if (live.liveIdentityFingerprint !== recordedFingerprint) {
    recordLaunchReadinessObservationFailure(deps, "sandbox-identity");
    throw new ObservationError("identity");
  }

  const policyStartedAt = performance.now();
  try {
    validateLivePolicy(sandboxName, gatewayName, deps);
  } catch (error) {
    recordLaunchReadinessObservationFailure(deps, "policy-get");
    throw error;
  } finally {
    recordObservationTiming(deps, "policy-get", policyStartedAt);
  }
  const inferenceSelection = normalizeInferenceSelection(entry);
  const inference = registry.getSandboxEntryInference(entry);
  const inferenceGetStartedAt = performance.now();
  let inferenceResult: ReturnType<typeof captureLaunchReadiness>;
  try {
    inferenceResult = (deps.capture ?? ((args) => captureLaunchReadiness(args)))(
      buildGatewayInferenceGetArgs(gatewayName),
    );
  } catch (error) {
    recordLaunchReadinessObservationFailure(deps, "inference-get");
    throw error;
  } finally {
    recordObservationTiming(deps, "inference-get", inferenceGetStartedAt);
  }
  if (inferenceResult.status !== 0) {
    recordLaunchReadinessObservationFailure(deps, "inference-get");
    throw new LaunchReadinessEvidenceError();
  }
  let liveInference: ReturnType<typeof parseGatewayInference>;
  let liveInferenceAbsent: boolean;
  try {
    liveInference = parseGatewayInference(inferenceResult.output);
    liveInferenceAbsent = reportsInferenceNotConfigured(inferenceResult.output);
  } catch (error) {
    recordLaunchReadinessObservationFailure(deps, "inference-get");
    throw error;
  }
  if (inference.kind === "configured") {
    if (!liveInference && !liveInferenceAbsent) {
      recordLaunchReadinessObservationFailure(deps, "inference-get");
      throw new LaunchReadinessEvidenceError();
    }
    if (planInferenceRouteReconcile(liveInference, inference).kind !== "aligned") {
      recordLaunchReadinessObservationFailure(deps, "inference-get");
      throw new ObservationError("config");
    }
  } else {
    if (liveInference) {
      recordLaunchReadinessObservationFailure(deps, "inference-get");
      throw new ObservationError("config");
    }
    if (!liveInferenceAbsent) {
      recordLaunchReadinessObservationFailure(deps, "inference-get");
      throw new LaunchReadinessEvidenceError();
    }
  }

  await requireLaunchSemanticHealth(
    sandboxName,
    gatewayName,
    agentName,
    entry,
    agent,
    inference.kind === "configured",
    deps,
  );

  let session: LaunchReadinessIdentity["session"] = null;
  if (agentName === "openclaw") {
    const openclawVersion = normalizedString(entry.agentVersion);
    const stateDirectory = normalizedString(agent.config?.dir);
    // Pairing qualification requires a versioned trusted definition. The
    // receipt binds the sandbox's recorded version, including supported stale
    // versions that the normal launch warning permits.
    if (!openclawVersion || !normalizedString(agent.expected_version) || !stateDirectory) {
      throw new OpenClawPairingQualificationError();
    }
    try {
      session = (deps.observeOpenClawPairingQualification ?? observeOpenClawPairingQualification)(
        sandboxName,
        gatewayName,
        openclawVersion,
        stateDirectory,
      );
    } catch {
      throw new OpenClawPairingQualificationError();
    }
  }

  return {
    identity: {
      registry: launchReadinessDigest(projection),
      agent: launchReadinessDigest(projectAgent(agent)),
      liveInference: launchReadinessDigest({
        selection: inferenceSelection,
        live: liveInference
          ? { provider: liveInference.provider, model: liveInference.model }
          : null,
      }),
      gatewayName,
      lifecycleGeneration,
      liveIdentityFingerprint: recordedFingerprint,
      session,
    },
    agent,
    sb: entry,
  };
}

function compareIdentity(
  left: LaunchReadinessIdentity,
  right: LaunchReadinessIdentity,
): "exact" | "config" | "session" {
  const baseMatches =
    left.registry === right.registry &&
    left.agent === right.agent &&
    left.liveInference === right.liveInference &&
    left.gatewayName === right.gatewayName &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.liveIdentityFingerprint === right.liveIdentityFingerprint;
  if (!baseMatches) return "config";
  return launchReadinessDigest(left.session) === launchReadinessDigest(right.session)
    ? "exact"
    : "session";
}

function debugDecision(category: LaunchReadinessDecisionCategory): void {
  log.debug(
    category === "accepted"
      ? "Launch readiness: accepted"
      : `Launch readiness: fallback due to ${category}`,
  );
}

function publicationValidationCategory(error: unknown): {
  category: LaunchReadinessPublicationValidationCategory;
  failedCheck?: LaunchReadinessFailedCheck;
} | null {
  if (!(error instanceof ObservationError)) return null;
  if (!["identity", "config", "health", "session"].includes(error.category)) return null;
  return {
    category: error.category as LaunchReadinessPublicationValidationCategory,
    ...(error.failedCheck ? { failedCheck: error.failedCheck } : {}),
  };
}

function fallback(
  category: Exclude<LaunchReadinessDecisionCategory, "accepted">,
  fence: LaunchReadinessFence | null,
  gatewayName: string | null,
  gatewayPort: number | null,
  fenceFailed: boolean,
  recoveryBlocked = false,
  authorityUnsupported = false,
): LaunchReadinessDecision {
  debugDecision(category);
  return {
    kind: "fallback",
    category,
    fence,
    gatewayName,
    gatewayPort,
    fenceFailed,
    recoveryBlocked,
    ...(authorityUnsupported ? { authorityUnsupported: true as const } : {}),
  };
}

function incompletePortablePairing(
  reason: Extract<PortableOpenClawPairingSettlementResult, { kind: "incomplete" }>["reason"],
): PortableOpenClawPairingSettlementResult {
  return { kind: "incomplete", reason };
}

function portableReceiptChanged(
  first: PortableLifecycleReceiptClassification,
  second: PortableLifecycleReceiptClassification,
): boolean {
  return (
    first.kind !== "current" ||
    second.kind !== "current" ||
    first.registryGeneration !== second.registryGeneration ||
    launchReadinessDigest(first.runtimeAuthority) !== launchReadinessDigest(second.runtimeAuthority)
  );
}

function resolveOpenClawPairingSettlementTarget(
  sandboxName: string,
  entry: SandboxEntry | null,
  deps: LaunchReadinessDeps,
  requiredGeneration?: string,
  allowUnknownCustomVersion = false,
): OpenClawPairingSettlementTarget | null {
  // Policy eligibility belongs to the settlement caller. Ordinary onboarding
  // permits policy skip, while Portable pairing requires the finalized marker.
  if (
    !entry ||
    entry.name !== sandboxName ||
    (entry.agent !== null && entry.agent !== "openclaw") ||
    entry.pendingRouteReservation === true ||
    !Number.isInteger(entry.gatewayPort) ||
    (entry.gatewayPort ?? 0) < 1 ||
    (entry.gatewayPort ?? 0) > 65535
  ) {
    return null;
  }
  const gatewayName = resolveGatewayName(entry.gatewayPort as number);
  if (entry.gatewayName !== gatewayName) return null;

  let agent: AgentDefinition;
  try {
    agent = resolveTrustedLaunchAgent(entry, deps, "openclaw");
  } catch {
    return null;
  }
  const recordedVersion = normalizedString(entry.agentVersion);
  // Custom Dockerfile workloads intentionally have no managed agent version:
  // registration must not stamp the manifest's version onto unreviewed image
  // contents. Ordinary settlement does not use the version to select a
  // command shape, so its caller may preserve that unknown value as the empty
  // string while retaining the exact registry and live-lifecycle checks.
  const customDockerfile = normalizedString(entry.fromDockerfile);
  const version = recordedVersion ?? (allowUnknownCustomVersion && customDockerfile ? "" : null);
  const expectedVersion = normalizedString(agent.expected_version);
  const stateDirectory = normalizedString(agent.config?.dir);
  const lifecycleGeneration = normalizedString(entry.lifecycleGeneration);
  const lifecycleLiveIdentityFingerprint = normalizedString(entry.lifecycleLiveIdentityFingerprint);
  if (
    version === null ||
    !expectedVersion ||
    !stateDirectory ||
    !lifecycleGeneration ||
    !lifecycleLiveIdentityFingerprint ||
    (requiredGeneration !== undefined && lifecycleGeneration !== requiredGeneration)
  ) {
    return null;
  }
  return {
    gatewayName,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint,
    stateDirectory,
    version,
  };
}

/** Resolve the finalized ordinary OpenClaw runtime that owns pairing state. */
export function resolveOrdinaryOpenClawPairingTarget(
  sandboxName: string,
  deps: LaunchReadinessDeps = {},
): OpenClawPairingSettlementTarget | null {
  try {
    const getSandbox = deps.getSandbox ?? registry.getSandbox;
    return resolveOpenClawPairingSettlementTarget(
      sandboxName,
      getSandbox(sandboxName),
      deps,
      undefined,
      true,
    );
  } catch {
    return null;
  }
}

/**
 * Settle current Portable OpenClaw pairing under the lifecycle then owning
 * gateway-route locks. The repair observation admits only one canonical local
 * write request; a final strict observation requires that request to be gone.
 * An ambiguous approval receives one bounded final observation window and
 * never another write.
 */
type PortablePairingWaitResult =
  | { readonly kind: "observed"; readonly value: OpenClawPairingRepairObservation }
  | { readonly kind: "rejected" }
  | { readonly kind: "timeout" };

async function waitForPortablePairingObservation(
  sandboxName: string,
  target: OpenClawPairingSettlementTarget,
  deadline: number,
  observe: typeof observeOpenClawPairingRepairSettlement,
  decide: (value: OpenClawPairingRepairObservation) => "accept" | "reject" | "retry",
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<PortablePairingWaitResult> {
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: "timeout" };
    try {
      const value = observe(sandboxName, target.gatewayName, target.version, target.stateDirectory);
      if (deadline - now() <= 0) return { kind: "timeout" };
      const decision = decide(value);
      if (deadline - now() <= 0) return { kind: "timeout" };
      if (decision === "accept") return { kind: "observed", value };
      if (decision === "reject") return { kind: "rejected" };
    } catch (error) {
      if (!(error instanceof OpenClawPairingObservationRetryableError)) {
        return { kind: "rejected" };
      }
    }
    const remainingAfterAttempt = deadline - now();
    if (remainingAfterAttempt <= 0) return { kind: "timeout" };
    await sleep(Math.min(OPENCLAW_ONBOARDING_PAIRING_POLL_MS, remainingAfterAttempt));
  }
}

export async function settlePortableOpenClawPairing(
  sandboxName: string,
  options: {
    readonly portableRequired?: boolean;
    readonly revalidateSandboxIdentity?: (operation: string) => void;
  } = {},
  deps: LaunchReadinessDeps = {},
): Promise<PortableOpenClawPairingSettlementResult> {
  const classifyReceipt = deps.classifyPortableLifecycleReceipt ?? classifyPortableLifecycleReceipt;
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const updateSandbox = deps.updateSandbox ?? registry.updateSandbox;
  const withSandboxLock = deps.withSandboxLock ?? withSandboxMutationLock;
  const withGatewayLock = deps.withGatewayLock ?? withGatewayRouteMutationLock;
  const observeRepairPairing =
    deps.observeOpenClawPairingRepairSettlement ?? observeOpenClawPairingRepairSettlement;
  const observeSettledPairing =
    deps.observeOpenClawPairingSettlement ?? observeOpenClawPairingSettlement;
  const runProducer = deps.runPortablePairingProducer ?? runPortableOpenClawPairingRequestProducer;
  const runApproval = deps.runPortablePairingApproval ?? runPortableOpenClawPairingApproval;
  const revalidateSandboxIdentity = options.revalidateSandboxIdentity;
  const now = deps.now ?? (() => performance.now());
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  return withSandboxLock(sandboxName, async () => {
    let firstEntry = getSandbox(sandboxName);
    if (
      firstEntry?.agent !== "openclaw" &&
      typeof firstEntry?.agent === "string" &&
      firstEntry.agent.length > 0 &&
      firstEntry.agent === firstEntry.agent.trim()
    ) {
      return { kind: "not-portable" };
    }

    const firstReceipt = classifyReceipt(sandboxName);
    if (
      firstEntry?.agent === null &&
      options.portableRequired === true &&
      portableLifecycleReceiptMatchesGeneration(firstReceipt, firstEntry.lifecycleGeneration)
    ) {
      revalidateSandboxIdentity?.(`update the recorded agent for sandbox '${sandboxName}'`);
      if (!updateSandbox(sandboxName, { agent: "openclaw" })) {
        return incompletePortablePairing("portable-runtime-identity-invalid");
      }
      firstEntry = getSandbox(sandboxName);
      if (firstEntry?.agent !== "openclaw") {
        return incompletePortablePairing("portable-runtime-identity-invalid");
      }
    }
    if (firstEntry?.agent !== "openclaw") {
      if (firstReceipt.kind === "absent" && !options.portableRequired) {
        return { kind: "not-portable" };
      }
      return incompletePortablePairing("portable-runtime-identity-invalid");
    }
    if (firstReceipt.kind === "absent") {
      return options.portableRequired
        ? incompletePortablePairing("portable-receipt-missing")
        : { kind: "not-portable" };
    }
    if (firstReceipt.kind !== "current") {
      return incompletePortablePairing("portable-receipt-invalid");
    }
    const firstTarget = resolveOpenClawPairingSettlementTarget(
      sandboxName,
      firstEntry,
      deps,
      firstReceipt.registryGeneration,
    );
    if (!firstTarget) return incompletePortablePairing("portable-runtime-identity-invalid");

    return withGatewayLock(firstTarget.gatewayName, async () => {
      const lockedReceipt = classifyReceipt(sandboxName);
      const lockedEntry = getSandbox(sandboxName);
      if (lockedReceipt.kind !== "current" || portableReceiptChanged(firstReceipt, lockedReceipt)) {
        return incompletePortablePairing("portable-receipt-invalid");
      }
      const target = resolveOpenClawPairingSettlementTarget(
        sandboxName,
        lockedEntry,
        deps,
        lockedReceipt.registryGeneration,
      );
      if (
        !target ||
        target.gatewayName !== firstTarget.gatewayName ||
        target.version !== firstTarget.version ||
        target.stateDirectory !== firstTarget.stateDirectory
      ) {
        return incompletePortablePairing("portable-runtime-identity-invalid");
      }

      const settlementDeadline = now() + OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS;
      const initialDeadline = Math.min(
        settlementDeadline,
        now() + OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
      );
      const initial = await waitForPortablePairingObservation(
        sandboxName,
        target,
        initialDeadline,
        observeRepairPairing,
        () => "accept",
        now,
        sleep,
      );
      if (initial.kind !== "observed") {
        return incompletePortablePairing("portable-pairing-incomplete");
      }
      const first = initial.value;
      if (first.state === "settled") {
        revalidateSandboxIdentity?.(
          `publish settled Portable OpenClaw pairing for sandbox '${sandboxName}'`,
        );
        return { kind: "settled" };
      }

      // A canonical pending transition is the producer's completed output.
      if (first.state === "pairing-only") {
        revalidateSandboxIdentity?.(
          `request Portable OpenClaw pairing for sandbox '${sandboxName}'`,
        );
        runProducer(sandboxName, target.gatewayName);
      }
      revalidateSandboxIdentity?.(
        `approve Portable OpenClaw pairing for sandbox '${sandboxName}'`,
      );
      runApproval(sandboxName, target.gatewayName, first.deviceIdentitySha256);

      const finalDeadline = Math.min(
        settlementDeadline,
        now() + OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
      );
      const final = await waitForPortablePairingObservation(
        sandboxName,
        target,
        finalDeadline,
        observeRepairPairing,
        (candidate) => {
          if (candidate.deviceIdentitySha256 !== first.deviceIdentitySha256) return "reject";
          if (candidate.state !== "settled") return "retry";
          const strict: OpenClawPairingSettlementObservation = observeSettledPairing(
            sandboxName,
            target.gatewayName,
            target.version,
            target.stateDirectory,
          );
          if (strict.deviceIdentitySha256 !== first.deviceIdentitySha256) return "reject";
          return strict.state === "settled" ? "accept" : "retry";
        },
        now,
        sleep,
      );
      if (final.kind !== "observed") {
        return incompletePortablePairing("portable-pairing-incomplete");
      }
      revalidateSandboxIdentity?.(
        `publish settled Portable OpenClaw pairing for sandbox '${sandboxName}'`,
      );
      return { kind: "settled" };
    });
  });
}

export function portableOpenClawPairingIncompleteMessage(
  sandboxName: string,
  reason: Extract<PortableOpenClawPairingSettlementResult, { kind: "incomplete" }>["reason"],
): string {
  const cause =
    reason === "portable-policy-incomplete"
      ? "its policy preset step is not finalized"
      : reason === "portable-receipt-missing"
        ? "its Portable lifecycle receipt is missing"
        : reason === "portable-receipt-invalid"
          ? "its Portable lifecycle receipt is invalid or legacy"
          : reason === "portable-runtime-identity-invalid"
            ? "its recorded Portable runtime identity is not authoritative"
            : "its local OpenClaw operator pairing is not settled";
  return `Portable onboarding for '${sandboxName}' is incomplete because ${cause}. Resume or rerun onboarding before connecting, recovering, or launching it.`;
}

/**
 * Validate or fence launch evidence under the canonical lifecycle then route
 * lock order. No recovery or readiness polling may run inside this function.
 */
export async function inspectLaunchReadiness(
  sandboxName: string,
  deps: LaunchReadinessDeps = {},
): Promise<LaunchReadinessDecision> {
  const withSandboxLock = deps.withSandboxLock ?? withSandboxMutationLock;
  const withGatewayLock = deps.withGatewayLock ?? withGatewayRouteMutationLock;
  return withSandboxLock(sandboxName, async () => {
    const entry = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
    if (!entry) return fallback("missing", null, null, null, true, true);
    let gatewayPort: number;
    let gatewayName: string;
    try {
      gatewayPort = entry.gatewayPort as number;
      if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
        throw new ObservationError("config");
      }
      gatewayName = resolveGatewayName(gatewayPort);
      if (entry.gatewayName !== gatewayName) throw new ObservationError("config");
    } catch (error) {
      const category = error instanceof ObservationError ? error.category : "config";
      return fallback(category, null, null, null, true, true);
    }
    return withGatewayLock(gatewayName, async () => {
      const storageStartedAt = performance.now();
      const read = (deps.readLease ?? readLaunchReadinessLease)(
        sandboxName,
        gatewayName,
        gatewayPort,
        deps.storeOptions,
      );
      recordPerformanceStage("storage-read", storageStartedAt);
      let category: Exclude<LaunchReadinessDecisionCategory, "accepted"> = classifyReceipt(read);
      if (read.kind === "valid") {
        const validationStartedAt = performance.now();
        try {
          const captured = await captureLaunchIdentity(sandboxName, gatewayName, gatewayPort, deps);
          const comparison = compareIdentity(read.lease.identity, captured.identity);
          if (comparison === "exact") {
            debugDecision("accepted");
            return {
              kind: "accepted",
              category: "accepted",
              agent: captured.agent,
              sb: captured.sb,
            };
          }
          category = comparison;
        } catch (error) {
          category =
            error instanceof ObservationError
              ? error.category
              : error instanceof OpenClawPairingQualificationError
                ? "session"
                : "unsafe";
        } finally {
          recordPerformanceStage("live-validation", validationStartedAt);
        }
      }

      const fenceStartedAt = performance.now();
      try {
        const fence = (deps.fenceLease ?? fenceLaunchReadinessLease)(
          sandboxName,
          gatewayName,
          gatewayPort,
          deps.storeOptions,
        );
        return fallback(category, fence, gatewayName, gatewayPort, false);
      } catch (error) {
        const recoveryBlocked =
          error instanceof LaunchReadinessFenceError ? error.blocksRecovery : true;
        return fallback(
          category === "missing" ? "unsafe" : category,
          null,
          gatewayName,
          gatewayPort,
          true,
          recoveryBlocked,
          error instanceof LaunchReadinessFenceError && error.authorityUnsupported,
        );
      } finally {
        recordPerformanceStage("evidence-fence", fenceStartedAt);
      }
    });
  });
}

/**
 * Enter the complete preflight mutation window only while the producer's
 * runtime epoch remains authoritative. Both canonical locks stay held until
 * the operation, final recapture, and publication finish. Nested lifecycle or
 * gateway lock users are reentrant through the canonical lock implementation.
 */
export async function withLaunchReadinessMutationGate<T>(
  publication: LaunchReadinessPublication,
  operation: () => Promise<T> | T,
  deps: LaunchReadinessDeps = {},
): Promise<LaunchReadinessMutationGateResult<T>> {
  const { sandboxName, gatewayName, gatewayPort, epochId } = publication;
  if (!gatewayName || !gatewayPort) return { kind: "unsafe" };
  const withSandboxLock = deps.withSandboxLock ?? withSandboxMutationLock;
  const withGatewayLock = deps.withGatewayLock ?? withGatewayRouteMutationLock;
  return withSandboxLock(sandboxName, async () => {
    const entry = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
    if (entry?.gatewayPort !== gatewayPort || entry.gatewayName !== gatewayName) {
      return { kind: "changed" };
    }
    return withGatewayLock(gatewayName, async () => {
      const authority = (deps.checkMutationAuthority ?? checkLaunchReadinessMutationAuthority)(
        sandboxName,
        gatewayName,
        gatewayPort,
        epochId,
        deps.storeOptions,
      );
      if (authority !== "current") return { kind: authority };
      return { kind: "entered", value: await operation() };
    });
  });
}

/** Re-observe final state and publish only when the original fence still wins. */
export async function publishLaunchReadiness(
  publication: LaunchReadinessPublication,
  deps: LaunchReadinessDeps = {},
): Promise<LaunchReadinessPublicationResult> {
  const { sandboxName, gatewayName, gatewayPort, epochId } = publication;
  if (!gatewayName || !gatewayPort || !epochId) return { kind: "evidence-failed" };
  const withSandboxLock = deps.withSandboxLock ?? withSandboxMutationLock;
  const withGatewayLock = deps.withGatewayLock ?? withGatewayRouteMutationLock;
  try {
    return await withSandboxLock(sandboxName, async () => {
      const entry = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
      if (entry?.gatewayPort !== gatewayPort || entry.gatewayName !== gatewayName) {
        return { kind: "validation-failed", category: "identity" } as const;
      }
      return withGatewayLock(gatewayName, async () => {
        const validationStartedAt = performance.now();
        let captured: Awaited<ReturnType<typeof captureLaunchIdentity>>;
        try {
          captured = await captureLaunchIdentity(sandboxName, gatewayName, gatewayPort, deps);
        } catch (error) {
          const validation = publicationValidationCategory(error);
          return validation
            ? ({ kind: "validation-failed", ...validation } as const)
            : ({ kind: "evidence-failed" } as const);
        } finally {
          recordPerformanceStage("publication-validation", validationStartedAt);
        }
        const publicationStartedAt = performance.now();
        try {
          (deps.publishLease ?? publishLaunchReadinessLease)(
            sandboxName,
            gatewayName,
            gatewayPort,
            epochId,
            captured.identity,
            deps.storeOptions,
          );
        } catch {
          return { kind: "evidence-failed" } as const;
        } finally {
          recordPerformanceStage("publication-store", publicationStartedAt);
        }
        return { kind: "published" } as const;
      });
    });
  } catch {
    return { kind: "evidence-failed" };
  }
}

export function publicationFromDecision(
  sandboxName: string,
  decision: LaunchReadinessDecision,
): LaunchReadinessPublication {
  if (decision.kind === "accepted") {
    return { sandboxName, gatewayName: null, gatewayPort: null, epochId: null };
  }
  return {
    sandboxName,
    gatewayName: decision.gatewayName,
    gatewayPort: decision.gatewayPort,
    epochId: decision.fence?.epochId ?? null,
  };
}
