// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cloneAndDeepFreeze } from "../../core/immutable";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { isValidName, isValidProviderName } from "../../name-validation";
import {
  captureSandboxRebuildAuthority,
  type SandboxRebuildAuthority,
} from "../../state/registry/rebuild-authority";
import {
  cloneSandboxRuntimeSnapshot,
  type SandboxRuntimeSnapshot,
} from "../../state/registry/runtime-snapshot";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import type { SandboxMessagingState } from "../../state/registry-messaging";
import type { SnapshotRestoreAuthority } from "../../state/sandbox";
import {
  type ReboundManagedStartupClone,
  rebindManagedStartupProfileForClone,
} from "../managed-startup/clone-rebinder";
import type { ManagedStartupProfile } from "../managed-startup/profile";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import {
  normalizeRuntimeProviderIdentity,
  requireRuntimeProviderMutationAuthority,
} from "../runtime-provider/registry";
import { type ManagedWorkloadAuthority, readManagedWorkloadAuthority } from "./authority";

export interface ManagedWorkloadCloneSnapshot {
  readonly sandboxName: string;
  readonly agentType: string;
  readonly workload?: SandboxWorkloadReceipt;
  readonly runtimeSnapshot?: SandboxRuntimeSnapshot;
  /** Exact selected manifest and payload identity captured by the state layer. */
  readonly restoreAuthority: SnapshotRestoreAuthority;
}

export interface ManagedWorkloadCloneRegistryFields {
  readonly provider: SandboxEntry["provider"];
  readonly model: SandboxEntry["model"];
  readonly endpointUrl: SandboxEntry["endpointUrl"];
  readonly endpointSource: SandboxEntry["endpointSource"];
  readonly credentialEnv: SandboxEntry["credentialEnv"];
  readonly preferredInferenceApi: SandboxEntry["preferredInferenceApi"];
  readonly compatibleEndpointReasoning: SandboxEntry["compatibleEndpointReasoning"];
  readonly compatibleEndpointReasoningEffort: SandboxEntry["compatibleEndpointReasoningEffort"];
  readonly toolDisclosure: SandboxEntry["toolDisclosure"];
  readonly webSearchEnabled: SandboxEntry["webSearchEnabled"];
  readonly webSearchProvider: SandboxEntry["webSearchProvider"];
  readonly observabilityEnabled: SandboxEntry["observabilityEnabled"];
  readonly dcodeAutoApprovalMode?: SandboxEntry["dcodeAutoApprovalMode"];
  readonly hermesToolGateways?: readonly string[];
  readonly hermesInferenceProvider?: string;
  readonly hermesDashboardEnabled?: true;
  readonly hermesDashboardPort?: number;
  readonly hermesDashboardInternalPort?: number;
  readonly hermesDashboardTui?: true;
  readonly dashboardPort?: number;
  readonly dashboardRemoteBindPrepared: boolean;
}

export interface PreparedManagedWorkloadCloneHandoff {
  readonly schemaVersion: 1;
  readonly phase: "rebound";
  readonly providerId: string;
  readonly sourceSandboxName: string;
  readonly destinationSandboxName: string;
  /** Exact current registry row authority to revalidate at the mutation edge. */
  readonly sourceRegistryAuthority: SandboxRebuildAuthority;
  readonly sourceAuthority: ManagedWorkloadAuthority;
  readonly runtimeSnapshot: SandboxRuntimeSnapshot;
  readonly snapshotRestoreAuthority: SnapshotRestoreAuthority;
  readonly rebound: ReboundManagedStartupClone;
  readonly workload: Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;
  readonly messaging?: SandboxMessagingState;
  readonly registryFields: ManagedWorkloadCloneRegistryFields;
}

export interface PrepareManagedWorkloadCloneHandoffInput {
  readonly source: SandboxEntry;
  readonly snapshot: ManagedWorkloadCloneSnapshot;
  readonly destinationSandboxName: string;
  readonly destinationDashboardPort: number | null;
  readonly provider: RuntimeProviderBundle;
  /**
   * Provider-name ownership stays outside central clone orchestration. Hermes
   * supplies this resolver only when managed tools require a destination key.
   */
  readonly getHermesInferenceProviderName: (sandboxName: string) => string;
}

export class ManagedWorkloadCloneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed workload clone preflight failed: ${message}`, options);
    this.name = "ManagedWorkloadCloneError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_AUTHORITY_PATH_BYTES = 4096;

function fail(message: string, cause?: unknown): never {
  throw new ManagedWorkloadCloneError(message, cause === undefined ? undefined : { cause });
}

function requireSandboxName(value: string, label: string): string {
  if (!isValidName(value)) fail(`${label} sandbox name is invalid`);
  return value;
}

function requireProviderName(value: string, label: string): string {
  if (!isValidProviderName(value)) fail(`${label} provider name is invalid`);
  return value;
}

function cloneSnapshotRestoreAuthority(value: SnapshotRestoreAuthority): SnapshotRestoreAuthority {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.backupPath !== "string" ||
    !isAbsolute(value.backupPath) ||
    resolve(value.backupPath) !== value.backupPath ||
    value.backupPath.includes("\0") ||
    Buffer.byteLength(value.backupPath, "utf8") > MAX_AUTHORITY_PATH_BYTES ||
    typeof value.contentSha256 !== "string" ||
    !SHA256_PATTERN.test(value.contentSha256)
  ) {
    fail("snapshot content authority is invalid");
  }
  return {
    schemaVersion: 1,
    backupPath: value.backupPath,
    contentSha256: value.contentSha256,
  };
}

function readSnapshotAuthority(snapshot: ManagedWorkloadCloneSnapshot): ManagedWorkloadAuthority {
  let authority: ManagedWorkloadAuthority | null;
  try {
    authority = readManagedWorkloadAuthority({
      agent: snapshot.agentType,
      fromDockerfile: null,
      imageTag:
        snapshot.workload?.kind === "managed-image" ? snapshot.workload.reference : undefined,
      workload: snapshot.workload,
    });
  } catch (error) {
    fail(`snapshot '${snapshot.sandboxName}' has invalid managed workload authority`, error);
  }
  if (!authority) fail(`snapshot '${snapshot.sandboxName}' is not a managed workload`);
  return authority;
}

function registryFields(
  profile: ManagedStartupProfile,
  source: SandboxEntry,
): ManagedWorkloadCloneRegistryFields {
  const webSearch =
    profile.agentConfig.agent === "openclaw" || profile.agentConfig.agent === "hermes"
      ? profile.agentConfig.webSearch
      : null;
  const hermesDashboard = profile.dashboard.agent === "hermes" ? profile.dashboard : null;
  const dcodeConfig =
    profile.agentConfig.agent === "langchain-deepagents-code" ? profile.agentConfig : null;
  const hermesInferenceProvider =
    profile.agent === "hermes" && profile.tools.enabledGateways.length > 0
      ? profile.inference.upstreamProvider
      : undefined;
  const dashboardPort =
    profile.dashboard.agent === "openclaw"
      ? profile.dashboard.port
      : hermesDashboard?.mode === "loopback-forwarded"
        ? hermesDashboard.publicPort
        : undefined;
  return {
    // Snapshot peers retain the source gateway route. The isolated Hermes
    // provider owns only the destination sandbox's rotating runtime key.
    provider:
      hermesInferenceProvider === undefined ? profile.inference.upstreamProvider : source.provider,
    model: profile.inference.model,
    endpointUrl: source.endpointUrl ?? null,
    endpointSource: source.endpointSource ?? null,
    credentialEnv: source.credentialEnv ?? null,
    preferredInferenceApi: profile.inference.api,
    compatibleEndpointReasoning:
      profile.agent === "openclaw" && profile.inference.upstreamProvider === "compatible-endpoint"
        ? profile.tuning.reasoning
          ? "true"
          : "false"
        : null,
    compatibleEndpointReasoningEffort:
      profile.agent === "openclaw" &&
      profile.inference.upstreamProvider === "compatible-endpoint" &&
      profile.inference.api === "openai-completions" &&
      profile.tuning.reasoningEffort !== "default"
        ? profile.tuning.reasoningEffort
        : null,
    toolDisclosure: profile.tools.disclosure,
    webSearchEnabled: webSearch?.enabled === true,
    webSearchProvider: webSearch?.enabled === true ? webSearch.provider : null,
    observabilityEnabled: dcodeConfig?.observabilityEnabled === true,
    ...(dcodeConfig ? { dcodeAutoApprovalMode: dcodeConfig.autoApprovalMode } : {}),
    ...(profile.agent === "hermes" && profile.tools.enabledGateways.length > 0
      ? { hermesToolGateways: [...profile.tools.enabledGateways] }
      : {}),
    ...(hermesInferenceProvider === undefined ? {} : { hermesInferenceProvider }),
    ...(hermesDashboard?.mode === "loopback-forwarded"
      ? {
          hermesDashboardEnabled: true as const,
          hermesDashboardPort: hermesDashboard.publicPort,
          hermesDashboardInternalPort: hermesDashboard.internalPort,
          ...(hermesDashboard.tuiEnabled ? { hermesDashboardTui: true as const } : {}),
        }
      : {}),
    ...(dashboardPort === undefined ? {} : { dashboardPort }),
    dashboardRemoteBindPrepared:
      profile.dashboard.agent === "openclaw" && profile.dashboard.bindAddress === "0.0.0.0",
  };
}

function reboundWorkload(
  source: ManagedWorkloadAuthority,
  rebound: ReboundManagedStartupClone,
  provider: RuntimeProviderBundle,
): Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }> {
  const candidate = {
    ...source.receipt,
    encodedProfile: rebound.encodedProfile,
    startupProfileSha256: rebound.startupProfileSha256,
    ...(rebound.corporateCaB64 === undefined ? {} : { corporateCaB64: rebound.corporateCaB64 }),
  } as const;
  const normalized = cloneSandboxWorkloadReceipt(candidate);
  if (normalized?.kind !== "managed-image") {
    fail("rebound managed workload receipt is invalid");
  }
  const immutable = cloneAndDeepFreeze(normalized);
  if (!provider.workload.acceptsReceipt(immutable)) {
    fail(`provider '${provider.identity.id}' rejected the rebound workload receipt`);
  }
  return immutable;
}

function reboundMessaging(
  profile: ManagedStartupProfile,
  destinationSandboxName: string,
): SandboxMessagingState | undefined {
  if (profile.messaging.plan === null) return undefined;
  if (profile.agent === "langchain-deepagents-code" || profile.agent === "pi") {
    fail(`${profile.agent} clone unexpectedly produced a messaging plan`);
  }
  const agent = profile.agent;
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const plan = parseSandboxMessagingPlan(profile.messaging.plan, {
    sandboxName: destinationSandboxName,
    agent,
    supportedChannelIds: manifestRegistry.listAvailable({ agent }).map((manifest) => manifest.id),
    environment: {
      NEMOCLAW_PROXY_HOST: profile.proxy.managedHost,
      NEMOCLAW_PROXY_PORT: String(profile.proxy.managedPort),
    },
  });
  if (!plan) fail("rebound messaging plan is invalid");
  return { schemaVersion: 1, plan };
}

/**
 * Build the provider-bound, secret-free handoff consumed by the later held
 * create/bootstrap transaction. This function performs no provider, registry,
 * filesystem, credential, or sandbox mutation.
 */
export function prepareManagedWorkloadCloneHandoff(
  input: PrepareManagedWorkloadCloneHandoffInput,
): PreparedManagedWorkloadCloneHandoff {
  const sourceSandboxName = requireSandboxName(input.source.name, "source");
  const snapshotSandboxName = requireSandboxName(input.snapshot.sandboxName, "snapshot source");
  const destinationSandboxName = requireSandboxName(input.destinationSandboxName, "destination");
  if (sourceSandboxName !== snapshotSandboxName) {
    fail("snapshot source identity does not match the current source sandbox");
  }
  if (sourceSandboxName === destinationSandboxName) {
    fail("source and destination sandbox names must differ");
  }

  const providerId = normalizeRuntimeProviderIdentity(input.source.openshellDriver);
  if (
    providerId !== input.provider.identity.id ||
    input.provider.workload.providerId !== input.provider.identity.id
  ) {
    fail(
      `source provider '${providerId}' does not match selected provider ` +
        `'${input.provider.identity.id}'`,
    );
  }
  try {
    requireRuntimeProviderMutationAuthority(input.provider, "clone");
  } catch (error) {
    fail(`provider '${input.provider.identity.id}' does not authorize clone handoff`, error);
  }

  let sourceRegistryAuthority: SandboxRebuildAuthority;
  try {
    sourceRegistryAuthority = captureSandboxRebuildAuthority(
      input.source,
      input.provider.identity.id,
    );
  } catch (error) {
    fail(`source '${sourceSandboxName}' has no exact registry generation authority`, error);
  }

  let currentAuthority: ManagedWorkloadAuthority | null;
  try {
    currentAuthority = readManagedWorkloadAuthority(input.source);
  } catch (error) {
    fail(`source '${sourceSandboxName}' has invalid managed workload authority`, error);
  }
  if (!currentAuthority) fail(`source '${sourceSandboxName}' is not a managed workload`);
  const snapshotAuthority = readSnapshotAuthority(input.snapshot);
  if (!isDeepStrictEqual(currentAuthority, snapshotAuthority)) {
    fail("current source managed authority no longer matches the selected snapshot");
  }
  if (!input.provider.workload.acceptsReceipt(snapshotAuthority.receipt)) {
    fail(`provider '${input.provider.identity.id}' rejected the snapshot workload receipt`);
  }

  const runtimeSnapshot = cloneSandboxRuntimeSnapshot(input.snapshot.runtimeSnapshot);
  if (
    !runtimeSnapshot ||
    runtimeSnapshot.providerId !== input.provider.identity.id ||
    runtimeSnapshot.runtime.providerId !== input.provider.identity.id
  ) {
    fail("snapshot runtime authority does not belong to the selected provider");
  }
  const snapshotRestoreAuthority = cloneSnapshotRestoreAuthority(input.snapshot.restoreAuthority);

  const needsHermesInferenceProvider =
    snapshotAuthority.agent === "hermes" &&
    Array.isArray(input.source.hermesToolGateways) &&
    input.source.hermesToolGateways.length > 0;
  const destinationHermesInferenceProvider = needsHermesInferenceProvider
    ? requireProviderName(
        input.getHermesInferenceProviderName(destinationSandboxName),
        "destination Hermes inference",
      )
    : undefined;

  let rebound: ReboundManagedStartupClone;
  try {
    rebound = rebindManagedStartupProfileForClone({
      sourceSandboxName,
      destinationSandboxName,
      expectedAgent: snapshotAuthority.agent,
      destinationDashboardPort: input.destinationDashboardPort,
      ...(destinationHermesInferenceProvider === undefined
        ? {}
        : { destinationHermesInferenceProvider }),
      encodedProfile: snapshotAuthority.receipt.encodedProfile,
      startupProfileSha256: snapshotAuthority.receipt.startupProfileSha256,
      ...(snapshotAuthority.receipt.corporateCaB64 === undefined
        ? {}
        : { corporateCaB64: snapshotAuthority.receipt.corporateCaB64 }),
      currentSource: input.source,
    });
  } catch (error) {
    fail("managed startup profile could not be rebound", error);
  }
  const workload = reboundWorkload(snapshotAuthority, rebound, input.provider);
  const messaging = reboundMessaging(rebound.profile, destinationSandboxName);

  return cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    phase: "rebound" as const,
    providerId: input.provider.identity.id,
    sourceSandboxName,
    destinationSandboxName,
    sourceRegistryAuthority,
    sourceAuthority: snapshotAuthority,
    runtimeSnapshot,
    snapshotRestoreAuthority,
    rebound,
    workload,
    ...(messaging === undefined ? {} : { messaging }),
    registryFields: registryFields(rebound.profile, input.source),
  });
}
