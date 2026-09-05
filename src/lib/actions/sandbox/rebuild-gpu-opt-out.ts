// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  type InferenceEndpointSource,
  normalizeInferenceEndpointSource,
} from "../../inference/selection";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import {
  type DcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "../../onboard/dcode-auto-approval";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import { isDcodeAgent } from "../../onboard/observability-policy-presets";
import { normalizePersistedSandboxHostMounts } from "../../state/registry/host-mount";
import type {
  PreparedDcodeRebuildHandoff,
  PreparedImageRebuildHandoff,
} from "../../onboard/prepared-dcode-rebuild";
import type {
  ProviderRecoveryReceipt,
  RebuildProviderReconfigureHandoff,
  RebuildRouteHandoff,
} from "../../onboard/rebuild-route-handoff";
import { normalizeSandboxGpuMode } from "../../onboard/sandbox-gpu-mode";
import type { ManagedWorkloadRebuildHandoff } from "../../onboard/workload/rebuild";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { PreservedEnvFile } from "../../state/preserved-env";
import { type ToolDisclosure, toolDisclosureOrDefault } from "../../tool-disclosure";

export type RebuildGpuOptOutEntry = {
  sandboxGpuMode?: string | null;
  sandboxGpuEnabled?: boolean;
  sandboxGpuDevice?: string | null;
  gpuEnabled?: boolean;
  dashboardPort?: number | null;
  gatewayName?: string | null;
  gatewayPort?: number | null;
  toolDisclosure?: ToolDisclosure;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  observabilityEnabled?: boolean;
  endpointSource?: InferenceEndpointSource | null;
  provider?: string | null;
  model?: string | null;
  preferredInferenceApi?: string | null;
  hostMounts?: import("../../state/registry/types").SandboxHostMount[];
};

// Modern source of truth is the persisted `sandboxGpuMode` string ("0" / "1" /
// "auto"). The legacy `gpuEnabled` fallback only runs for older entries with
// no recorded mode field — a malformed but present `sandboxGpuMode` value is
// treated as "do nothing" rather than silently routed through the legacy
// path, so corrupted state cannot flip a sandbox into a permanent opt-out.
function hasRecordedGpuMode(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function rebuildShouldOptOutGpu(sb: RebuildGpuOptOutEntry | null | undefined): boolean {
  if (!sb) return false;
  const mode = normalizeSandboxGpuMode(sb.sandboxGpuMode);
  if (mode === "0") return true;
  if (mode === "1" || mode === "auto") return false;
  if (hasRecordedGpuMode(sb.sandboxGpuMode)) return false;
  if (sb.sandboxGpuEnabled === true) return false;
  return sb.gpuEnabled === false;
}

export function getRebuildSandboxGpuOverrides(sb: RebuildGpuOptOutEntry | null | undefined): {
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
  sessionGpuPassthrough: boolean;
} {
  const mode = normalizeSandboxGpuMode(sb?.sandboxGpuMode);
  if (mode === "1") {
    return {
      sandboxGpu: "enable",
      sandboxGpuDevice: sb?.sandboxGpuDevice?.trim() || null,
      sessionGpuPassthrough: true,
    };
  }
  if (mode === "0") {
    return { sandboxGpu: "disable", sandboxGpuDevice: null, sessionGpuPassthrough: false };
  }
  if (hasRecordedGpuMode(sb?.sandboxGpuMode) && mode === null) {
    throw new Error(`Invalid recorded sandbox GPU mode '${String(sb?.sandboxGpuMode)}'.`);
  }
  if (mode === "auto") {
    // A false cached value keeps resume's legacy fallback from converting
    // recorded auto mode into forced enable after the old registry row is
    // temporarily removed. Fresh preflight recomputes actual auto detection.
    return { sandboxGpu: null, sandboxGpuDevice: null, sessionGpuPassthrough: false };
  }
  if (sb?.gpuEnabled === false) {
    return { sandboxGpu: "disable", sandboxGpuDevice: null, sessionGpuPassthrough: false };
  }
  return { sandboxGpu: null, sandboxGpuDevice: null, sessionGpuPassthrough: false };
}

export type RebuildRecreateOnboardOpts = {
  resume: true;
  nonInteractive: true;
  recreateSandbox: true;
  authoritativeResumeConfig: true;
  /** Internal permission granted only by a validated prepared-backup recovery. */
  allowRemovedImmutabilityStateRecord?: true;
  endpointSource?: InferenceEndpointSource | null;
  acceptThirdPartySoftware: true;
  agent: string | null | undefined;
  recreateProvider: string | null;
  recreateModel: string | null;
  recreatePreferredInferenceApi: string | null;
  fromDockerfile: string | null;
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
  controlUiPort: number | null;
  targetGatewayName: string;
  targetGatewayPort: number;
  runtimeSelection?: OpenShellRuntimeSelection;
  onboardLockAlreadyHeld: true;
  deferProcessExit: true;
  /** Target fingerprint of the replacement journal opened before deletion. */
  recreateJournalTargetIntentFingerprint?: string;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
  rebuildRegistryInferenceRoute?: RebuildRouteHandoff;
  rebuildProviderReconfigure?: RebuildProviderReconfigureHandoff;
  providerRecoveryReceipt?: ProviderRecoveryReceipt;
  /** Recorded provider intent admitted only by the N1x readiness exception. */
  allowDeferredN1xManagedVllm?: true;
  /** Target-scoped authority admitted by the authoritative rebuild preflight. */
  rebuildGatewayAuthority?: CheckpointGatewayAuthority;
  preparedImageRebuild?: PreparedImageRebuildHandoff;
  managedWorkloadRebuild?: ManagedWorkloadRebuildHandoff;
  rebuildPreservedEnv?: readonly PreservedEnvFile[];
  rebuildPolicySourcePath?: string;
  hostMounts?: readonly import("../../state/registry/types").SandboxHostMount[];
  autoYes: boolean;
  toolDisclosure: ToolDisclosure;
  dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  /** Whether the rebuild command explicitly overrode recorded DCode auto-approval state. */
  dcodeAutoApprovalRequestedExplicitly: boolean;
  observabilityEnabled: boolean;
  /** Whether the rebuild command explicitly overrode the recorded observability state. */
  observabilityRequestedExplicitly: boolean;
  baseImageResolutionHint: SandboxBaseImageResolutionMetadata | null;
  preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata;
  noGpu?: true;
};

export function buildRebuildRecreateOnboardOpts(args: {
  sb: RebuildGpuOptOutEntry | null | undefined;
  rebuildAgent: string | null | undefined;
  storedFromDockerfile: string | null;
  preparedDcodeRebuild?: PreparedDcodeRebuildHandoff;
  autoYes: boolean;
  baseImageResolutionHint?: SandboxBaseImageResolutionMetadata | null;
  usageNoticeAccepted: true;
}): RebuildRecreateOnboardOpts {
  if (args.sb?.observabilityEnabled === true && !isDcodeAgent(args.rebuildAgent)) {
    throw new Error(
      "Recorded observability state is valid only for agent 'langchain-deepagents-code'.",
    );
  }
  const gpuOverrides = getRebuildSandboxGpuOverrides(args.sb);
  const hostMounts = normalizePersistedSandboxHostMounts(args.sb?.hostMounts);
  const targetGatewayName = resolveSandboxGatewayName(args.sb);
  const targetGatewayPort = resolveGatewayPortFromName(targetGatewayName);
  if (targetGatewayPort === null) {
    throw new Error(`Cannot resolve persisted gateway port for '${targetGatewayName}'.`);
  }
  const dashboardPort = args.sb?.dashboardPort;
  if (
    dashboardPort !== undefined &&
    dashboardPort !== null &&
    (!Number.isInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535)
  ) {
    throw new Error(`Invalid persisted dashboard port '${String(dashboardPort)}'.`);
  }
  const managesDashboard = shouldManageDashboardForAgent(
    loadAgent(args.rebuildAgent || "openclaw"),
  );
  if (managesDashboard && (!dashboardPort || dashboardPort < 1)) {
    throw new Error(
      "Cannot recreate a dashboard-managed sandbox without its persisted dashboard port.",
    );
  }
  return {
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
    authoritativeResumeConfig: true,
    endpointSource: normalizeInferenceEndpointSource(args.sb?.endpointSource),
    acceptThirdPartySoftware: args.usageNoticeAccepted,
    agent: args.rebuildAgent,
    recreateProvider: args.sb?.provider ?? null,
    recreateModel: args.sb?.model ?? null,
    recreatePreferredInferenceApi: args.sb?.preferredInferenceApi ?? null,
    fromDockerfile: args.storedFromDockerfile,
    sandboxGpu: gpuOverrides.sandboxGpu,
    sandboxGpuDevice: gpuOverrides.sandboxGpuDevice,
    controlUiPort: managesDashboard ? (dashboardPort ?? null) : null,
    targetGatewayName,
    targetGatewayPort,
    onboardLockAlreadyHeld: true,
    deferProcessExit: true,
    ...(args.preparedDcodeRebuild ? { preparedDcodeRebuild: args.preparedDcodeRebuild } : {}),
    autoYes: args.autoYes,
    toolDisclosure: toolDisclosureOrDefault(args.sb?.toolDisclosure),
    dcodeAutoApprovalMode: normalizeDcodeAutoApprovalMode(args.sb?.dcodeAutoApprovalMode),
    dcodeAutoApprovalRequestedExplicitly: false,
    observabilityEnabled: args.sb?.observabilityEnabled === true,
    observabilityRequestedExplicitly: false,
    baseImageResolutionHint: args.baseImageResolutionHint ?? null,
    ...(rebuildShouldOptOutGpu(args.sb) ? { noGpu: true as const } : {}),
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
  };
}
