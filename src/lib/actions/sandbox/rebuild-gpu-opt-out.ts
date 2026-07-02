// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import { HERMES_OPENAI_API_PORT } from "../../core/ports";
import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
  type HermesDashboardConfig,
  readHermesDashboardConfig,
} from "../../hermes-dashboard";
import type { WebSearchConfig } from "../../inference/web-search";
import type { PreparedSandboxBuildContext } from "../../onboard/build-context-stage";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import type { FatalRuntimePreflightResult } from "../../onboard/fatal-runtime-preflight";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import type { InitialSandboxPolicy } from "../../onboard/initial-policy";
import { normalizeSandboxGpuMode } from "../../onboard/sandbox-gpu-mode";
import { getTier } from "../../policy/tiers";
import type { ResourceProfile } from "../../resources-cmd";
import type { CustomPolicyEntry } from "../../state/registry";

export type RebuildGpuOptOutEntry = {
  sandboxGpuMode?: string | null;
  sandboxGpuEnabled?: boolean;
  sandboxGpuDevice?: string | null;
  gpuEnabled?: boolean;
  dashboardPort?: number | null;
  gatewayName?: string | null;
  gatewayPort?: number | null;
  policyTier?: string | null;
  resourceCpu?: string | null;
  resourceMemory?: string | null;
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
  customPolicies?: CustomPolicyEntry[];
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
} {
  const mode = normalizeSandboxGpuMode(sb?.sandboxGpuMode);
  if (mode === "1") {
    return {
      sandboxGpu: "enable",
      sandboxGpuDevice: sb?.sandboxGpuDevice?.trim() || null,
    };
  }
  if (mode === "0") {
    return { sandboxGpu: "disable", sandboxGpuDevice: null };
  }
  if (hasRecordedGpuMode(sb?.sandboxGpuMode) && mode === null) {
    throw new Error(`Invalid recorded sandbox GPU mode '${String(sb?.sandboxGpuMode)}'.`);
  }
  if (mode === "auto") {
    return { sandboxGpu: null, sandboxGpuDevice: null };
  }
  if (sb?.gpuEnabled === false) {
    return { sandboxGpu: "disable", sandboxGpuDevice: null };
  }
  return { sandboxGpu: null, sandboxGpuDevice: null };
}

export type RebuildRecreateOnboardOpts = {
  resume: true;
  nonInteractive: true;
  recreateSandbox: true;
  authoritativeResumeConfig: true;
  authoritativePolicyTier: string | null;
  authoritativeResourceProfile: ResourceProfile | null;
  authoritativeHermesDashboardConfig: HermesDashboardConfig | null;
  authoritativeWebSearchConfig: WebSearchConfig | null;
  authoritativeWebSearchValidated: boolean;
  authoritativeMessagingPrevalidated: boolean;
  authoritativeMessagingReuse?: {
    providers: string[];
    channels: string[];
    disabledChannels: string[];
    detachProviders: string[];
    extraProviders: string[];
    extraPlaceholderKeys: string[];
  };
  authoritativeRuntimePreflight?: FatalRuntimePreflightResult;
  authoritativeInitialPolicy?: InitialSandboxPolicy;
  authoritativeCustomPolicies: CustomPolicyEntry[];
  acceptThirdPartySoftware: true;
  agent: string | null | undefined;
  fromDockerfile: string | null;
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
  controlUiPort: number | null;
  targetGatewayName: string;
  targetGatewayPort: number;
  onboardLockAlreadyHeld: true;
  preparedBuildContext?: PreparedSandboxBuildContext;
  authoritativeDockerGpuPatchNetwork?: string | null;
  autoYes: boolean;
  noGpu?: true;
};

export function buildRebuildRecreateOnboardOpts(args: {
  sb: RebuildGpuOptOutEntry | null | undefined;
  rebuildAgent: string | null | undefined;
  storedFromDockerfile: string | null;
  webSearchConfig: WebSearchConfig | null;
  autoYes: boolean;
}): RebuildRecreateOnboardOpts {
  const gpuOverrides = getRebuildSandboxGpuOverrides(args.sb);
  const targetGatewayName = resolveSandboxGatewayName(args.sb);
  const targetGatewayPort = resolveGatewayPortFromName(targetGatewayName);
  if (targetGatewayPort === null) {
    throw new Error(`Cannot resolve persisted gateway port for '${targetGatewayName}'.`);
  }
  const dashboardPort = args.sb?.dashboardPort;
  if (
    dashboardPort !== undefined &&
    dashboardPort !== null &&
    (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535)
  ) {
    throw new Error(`Invalid persisted dashboard port '${String(dashboardPort)}'.`);
  }
  const managesDashboard = shouldManageDashboardForAgent(
    loadAgent(args.rebuildAgent || "openclaw"),
  );
  if (managesDashboard && dashboardPort == null) {
    throw new Error(
      "Cannot recreate a dashboard-managed sandbox without its persisted dashboard port.",
    );
  }
  const authoritativePolicyTier = args.sb?.policyTier?.trim().toLowerCase() || null;
  if (authoritativePolicyTier && !getTier(authoritativePolicyTier)) {
    throw new Error(`Invalid persisted policy tier '${authoritativePolicyTier}'.`);
  }
  const recordedResourceCpu = args.sb?.resourceCpu;
  const recordedResourceMemory = args.sb?.resourceMemory;
  let authoritativeResourceProfile: ResourceProfile | null = null;
  if (recordedResourceCpu != null || recordedResourceMemory != null) {
    if (
      typeof recordedResourceCpu !== "string" ||
      typeof recordedResourceMemory !== "string" ||
      recordedResourceCpu.trim().length === 0 ||
      recordedResourceMemory.trim().length === 0
    ) {
      throw new Error(
        "Invalid persisted sandbox resource configuration: CPU and memory must both be non-empty.",
      );
    }
    authoritativeResourceProfile = {
      cpu: recordedResourceCpu.trim(),
      memory: recordedResourceMemory.trim(),
    };
  }
  let authoritativeHermesDashboardConfig: HermesDashboardConfig | null = null;
  if (args.rebuildAgent === "hermes" && args.sb?.hermesDashboardEnabled === true) {
    const dashboardPort = args.sb.hermesDashboardPort;
    const internalPort = args.sb.hermesDashboardInternalPort;
    if (dashboardPort == null || internalPort == null) {
      throw new Error("Cannot recreate an enabled Hermes dashboard without its persisted ports.");
    }
    authoritativeHermesDashboardConfig = readHermesDashboardConfig({
      [HERMES_DASHBOARD_ENABLE_ENV]: "1",
      [HERMES_DASHBOARD_PORT_ENV]: String(dashboardPort),
      [HERMES_DASHBOARD_INTERNAL_PORT_ENV]: String(internalPort),
      ...(args.sb.hermesDashboardTui ? { [HERMES_DASHBOARD_TUI_ENV]: "1" } : {}),
    });
    if (
      dashboardPort === internalPort ||
      dashboardPort === HERMES_OPENAI_API_PORT ||
      internalPort === HERMES_OPENAI_API_PORT ||
      (args.sb.dashboardPort != null &&
        (dashboardPort === args.sb.dashboardPort || internalPort === args.sb.dashboardPort))
    ) {
      throw new Error("Invalid persisted Hermes dashboard port configuration.");
    }
  }
  return {
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
    authoritativeResumeConfig: true,
    authoritativePolicyTier,
    authoritativeResourceProfile,
    authoritativeHermesDashboardConfig,
    authoritativeWebSearchConfig: args.webSearchConfig,
    authoritativeWebSearchValidated: false,
    authoritativeMessagingPrevalidated: false,
    authoritativeCustomPolicies: Array.isArray(args.sb?.customPolicies)
      ? args.sb.customPolicies.map((policy) => ({ ...policy }))
      : [],
    acceptThirdPartySoftware: true,
    agent: args.rebuildAgent,
    fromDockerfile: args.storedFromDockerfile,
    sandboxGpu: gpuOverrides.sandboxGpu,
    sandboxGpuDevice: gpuOverrides.sandboxGpuDevice,
    controlUiPort: managesDashboard ? (dashboardPort ?? null) : null,
    targetGatewayName,
    targetGatewayPort,
    onboardLockAlreadyHeld: true,
    autoYes: args.autoYes,
    ...(rebuildShouldOptOutGpu(args.sb) ? { noGpu: true as const } : {}),
  };
}
