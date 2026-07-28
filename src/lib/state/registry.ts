// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type { InferenceSelection } from "../inference/selection";
import {
  inferenceSelectionRegistryFields,
  normalizeInferenceSelection,
} from "../inference/selection";
import { normalizeToolDisclosure, type ToolDisclosure } from "../tool-disclosure";
import {
  applyAddExtraProvider,
  applyRemoveExtraProvider,
  isValidExtraProviderName,
  readExtraProviders,
} from "./extra-providers";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore";
import { normalizeSandboxMcpState, type SandboxMcpState } from "./registry-mcp";
import type { SandboxMessagingState } from "./registry-messaging";
import {
  normalizeBaselineExclusions,
  normalizeBaselineExclusionTransition,
  retainedDefaultSandbox,
} from "./registry-normalization";
import * as reversibleRemoval from "./registry-reversible-removal";
import { withLock } from "./registry/lock";
import { load, save } from "./registry/persistence";

export {
  getSandboxEntryDisplayInference,
  getSandboxEntryInference,
  type SandboxEntryDisplayInference,
  type SandboxEntryInference,
} from "./registry-entry-view";

import type { WebSearchProvider } from "../inference/web-search";
import {
  type DcodeAutoApprovalMode,
  isDcodeAutoApprovalMode,
} from "../onboard/dcode-auto-approval";
import {
  cloneSandboxMessagingState,
  getConfiguredMessagingChannels as getRegistryConfiguredMessagingChannels,
  getDisabledChannels as getRegistryDisabledChannels,
  setChannelDisabled as setRegistryChannelDisabled,
} from "./registry-messaging";

export type { McpBridgeEntry, SandboxMcpState } from "./registry-mcp";

export {
  acquireLock,
  classifyExistingLock,
  LOCK_DIR,
  LOCK_MAX_RETRIES,
  LOCK_OWNER,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  releaseLock,
  type RegistryLockDecision,
  withLock,
} from "./registry/lock";

export { load, REGISTRY_FILE, save } from "./registry/persistence";

export {
  getConfiguredMessagingChannelsFromEntry,
  getDisabledMessagingChannelsFromEntry,
  getHydratedMessagingPlanFromEntry,
  getMessagingPlanFromEntry,
  type SandboxMessagingState,
} from "./registry-messaging";

export interface CustomPolicyEntry {
  name: string;
  content: string;
  /** Desired content reserved before a crash-safe generated-policy transition. */
  pendingContent?: string;
  sourcePath?: string;
  appliedAt?: string;
}

export interface BaselineExclusionEntry {
  /** Persistence schema version for this reviewed exclusion intent. */
  version: 1;
  /** Agent baseline that supplied the reviewed entry. */
  agent: string;
  /** Exact baseline network policy key excluded, e.g. "nous_research". */
  key: string;
  /** Digest of the reviewed baseline entry content the approval was bound to. */
  digest: string;
  /** When the exclusion was acknowledged. */
  acknowledgedAt?: string;
  /** Agent build/version recorded when the exclusion was last applied. */
  appliedAgentVersion?: string | null;
}

export type BaselineExclusionTransitionOperation = "exclude" | "restore";

/**
 * Durable journal for the one cross-system baseline mutation that is in flight.
 * `baselineExclusions` remains the last committed operator intent until this
 * transaction is published after the live OpenShell mutation succeeds.
 */
export interface BaselineExclusionTransition {
  id: string;
  operation: BaselineExclusionTransitionOperation;
  exclusion: BaselineExclusionEntry;
  /** Exact live-entry digest that completes the transition; null means absent. */
  targetLiveDigest: string | null;
  startedAt: string;
}

// Outcome of the last live sandbox GPU proof run during onboarding/recovery.
// `status` separates a configured-but-unverified GPU from one whose CUDA
// usability was actually proven (`verified`) or actively failed a live proof
// (`failed`, e.g. Jetson `/dev/nvmap` permission errors). Persisted so
// `nemoclaw <sandbox> status` can report proof state instead of treating any
// configured GPU as healthy (#4231).
export type SandboxGpuProofStatus = "verified" | "unverified" | "failed";

export interface SandboxGpuProofResult {
  status: SandboxGpuProofStatus;
  // True only when a CUDA-usability proof (cuInit via libcuda) actually passed.
  cudaVerified: boolean;
  // Label of the last proof that determined `status`.
  label?: string | null;
  // Redacted, truncated diagnostic captured when the proof failed.
  detail?: string | null;
  at: string;
}

export interface SandboxEntry extends Partial<InferenceSelection> {
  name: string;
  /** Route-only placeholder created before sandbox creation; never eligible as the default. */
  pendingRouteReservation?: true;
  /** Onboard session that owns a pending reservation, so resume preserves its own row while abandoned reservations stay reconcilable. */
  reservationSessionId?: string;
  createdAt?: string;
  gpuEnabled?: boolean;
  hostGpuDetected?: boolean;
  sandboxGpuEnabled?: boolean;
  sandboxGpuMode?: "auto" | "1" | "0" | string | null;
  sandboxGpuDevice?: string | null;
  sandboxGpuProof?: SandboxGpuProofResult | null;
  openshellDriver?: string | null;
  openshellVersion?: string | null;
  policies?: string[];
  customPolicies?: CustomPolicyEntry[];
  /** Operator exclusions from the agent baseline policy, replayed on rebuild. */
  baselineExclusions?: BaselineExclusionEntry[];
  /** Crash-recoverable journal for an exclusion/restore live-policy mutation. */
  baselineExclusionTransition?: BaselineExclusionTransition;
  policyTier?: string | null;
  // True once the onboard policy step has fully completed and reconciled the
  // effective preset selection (set by the post-policy registry write). Absent
  // on a sandbox whose registration recorded only boot-time presets but whose
  // policy step never finished — so re-onboard knows whether `policies`
  // represents a final selection it can carry forward. See #4621.
  policyPresetsFinalized?: boolean;
  webSearchEnabled?: boolean;
  /** Selected disclosure preference; model compatibility safeguards may downgrade runtime behavior. */
  toolDisclosure?: ToolDisclosure;
  /** Enables backend-neutral trace export to the fixed local OTLP collector boundary. */
  observabilityEnabled?: boolean;
  /** Image-baked permission to expose DCode's per-thread auto-approval opt-in. */
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  /** Durable provider identity for enabled managed web search. */
  webSearchProvider?: WebSearchProvider | null;
  agent?: string | null;
  agentVersion?: string | null;
  /** Plugin install baseline captured before state is restored into a fresh OpenClaw image. */
  openclawImagePluginInstalls?: OpenClawImagePluginInstall[];
  // NemoClaw build fingerprint (the NemoClaw CLI/build version) stamped only on
  // NemoClaw-managed images at create/rebuild time. `upgrade-sandboxes` compares
  // it against the running NemoClaw build so an image/build change with an
  // unchanged agent version is still detected as needing a rebuild. Custom-image
  // (`--from`) sandboxes are intentionally left without a fingerprint so they
  // are never auto-rebuilt onto the default image (#5026).
  nemoclawVersion?: string | null;
  fromDockerfile?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  imageTag?: string | null;
  messaging?: SandboxMessagingState;
  mcp?: SandboxMcpState;
  hermesToolGateways?: string[];
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
  dashboardPort?: number | null;
  /** Remote dashboard exposure was included in the sandbox's generated config. */
  dashboardRemoteBindPrepared?: boolean;
  /** Generation proving which durable same-name recreate registered this row. */
  lifecycleGeneration?: string;
  /** Hashed OpenShell identity paired with lifecycleGeneration for exact recovery. */
  lifecycleLiveIdentityFingerprint?: string;
  // OpenShell gateway registration name and host port bound to this sandbox.
  // Persisted so later lifecycle commands operate on the sandbox's own gateway
  // instead of the process-global `nemoclaw` singleton — a second sandbox on a
  // different NEMOCLAW_GATEWAY_PORT no longer recreates/kills the first (#4422).
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

export interface SandboxRegistry {
  sandboxes: Record<string, SandboxEntry>;
  defaultSandbox: string | null;
  defaultSelectionRevision?: number;
  extraProviders?: string[];
}

export type SandboxRemovalReceipt = reversibleRemoval.RegistryRemovalReceipt<SandboxEntry>;

export function getSandbox(name: string): SandboxEntry | null {
  const data = load();
  return data.sandboxes[name] || null;
}

export function getDefault(): string | null {
  const data = load();
  if (
    data.defaultSandbox &&
    data.sandboxes[data.defaultSandbox] &&
    data.sandboxes[data.defaultSandbox].pendingRouteReservation !== true
  ) {
    return data.defaultSandbox;
  }
  const names = Object.values(data.sandboxes)
    .filter((sandbox) => sandbox.pendingRouteReservation !== true)
    .map((sandbox) => sandbox.name);
  return names.length > 0 ? names[0] || null : null;
}

export function registerSandbox(entry: SandboxEntry): void {
  withLock(() => {
    const data = load();
    if (retainedDefaultSandbox(data.defaultSandbox, data.sandboxes) === null) {
      data.defaultSandbox = null;
    }
    data.sandboxes[entry.name] = {
      name: entry.name,
      createdAt: entry.createdAt || new Date().toISOString(),
      ...inferenceSelectionRegistryFields(entry),
      gpuEnabled: entry.gpuEnabled || false,
      hostGpuDetected: entry.hostGpuDetected === true,
      sandboxGpuEnabled: entry.sandboxGpuEnabled === true,
      sandboxGpuMode: entry.sandboxGpuMode || null,
      sandboxGpuDevice: entry.sandboxGpuDevice || null,
      sandboxGpuProof: entry.sandboxGpuProof ?? null,
      openshellDriver: entry.openshellDriver || null,
      openshellVersion: entry.openshellVersion || null,
      policies: entry.policies || [],
      baselineExclusions: normalizeBaselineExclusions(entry.baselineExclusions),
      baselineExclusionTransition: normalizeBaselineExclusionTransition(
        entry.baselineExclusionTransition,
      ),
      policyTier: entry.policyTier || null,
      webSearchEnabled:
        typeof entry.webSearchEnabled === "boolean" ? entry.webSearchEnabled : undefined,
      // Preserve absence on reconstructed legacy rows. Only a freshly built
      // sandbox registration may claim the new progressive default.
      toolDisclosure: normalizeToolDisclosure(entry.toolDisclosure) ?? undefined,
      observabilityEnabled:
        typeof entry.observabilityEnabled === "boolean" ? entry.observabilityEnabled : undefined,
      dcodeAutoApprovalMode: isDcodeAutoApprovalMode(entry.dcodeAutoApprovalMode)
        ? entry.dcodeAutoApprovalMode
        : undefined,
      webSearchProvider:
        entry.webSearchEnabled === true &&
        (entry.webSearchProvider === "brave" || entry.webSearchProvider === "tavily")
          ? entry.webSearchProvider
          : null,
      // policyPresetsFinalized is intentionally not set here: registration means
      // the policy step has not completed for this entry. It is stamped only by
      // the post-policy registry write (see policy-preset-persistence), so a
      // snapshot clone (which spreads the source entry but resets `policies`)
      // cannot inherit a stale finalized marker. See #4621.
      agent: entry.agent || null,
      agentVersion: entry.agentVersion || null,
      openclawImagePluginInstalls: Array.isArray(entry.openclawImagePluginInstalls)
        ? entry.openclawImagePluginInstalls.map((install) => ({
            ...install,
            ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
          }))
        : undefined,
      nemoclawVersion: entry.nemoclawVersion || null,
      fromDockerfile: entry.fromDockerfile || null,
      hermesAuthMethod:
        entry.hermesAuthMethod === "oauth" || entry.hermesAuthMethod === "api_key"
          ? entry.hermesAuthMethod
          : null,
      imageTag: entry.imageTag || null,
      messaging: cloneSandboxMessagingState(entry.messaging),
      mcp: normalizeSandboxMcpState(entry.mcp),
      hermesToolGateways:
        Array.isArray(entry.hermesToolGateways) && entry.hermesToolGateways.length > 0
          ? [...entry.hermesToolGateways]
          : undefined,
      hermesDashboardEnabled: entry.hermesDashboardEnabled === true ? true : undefined,
      hermesDashboardPort: entry.hermesDashboardPort ?? undefined,
      hermesDashboardInternalPort: entry.hermesDashboardInternalPort ?? undefined,
      hermesDashboardTui: entry.hermesDashboardTui === true ? true : undefined,
      dashboardPort: entry.dashboardPort ?? undefined,
      dashboardRemoteBindPrepared: entry.dashboardRemoteBindPrepared === true ? true : undefined,
      gatewayName: entry.gatewayName ?? undefined,
      gatewayPort: entry.gatewayPort ?? undefined,
    };
    save(reversibleRemoval.claimInitialDefaultInRegistry(data, entry.name));
  });
}

type SandboxInferenceRouteReservation = Pick<
  InferenceSelection,
  | "provider"
  | "model"
  | "endpointUrl"
  | "endpointSource"
  | "credentialEnv"
  | "preferredInferenceApi"
> & {
  gatewayName: string;
  reservationSessionId?: string;
};

/**
 * Persist a route dependency before releasing the shared-gateway mutation
 * lock. A newly reserved row deliberately does not claim the default sandbox;
 * normal sandbox registration replaces it after creation completes.
 */
export function reserveSandboxInferenceRoute(
  name: string,
  route: SandboxInferenceRouteReservation,
): boolean {
  return withLock(() => {
    const data = load();
    const existing = data.sandboxes[name];
    const normalized = normalizeInferenceSelection(route);
    data.sandboxes[name] = {
      ...(existing ?? { name, pendingRouteReservation: true as const }),
      pendingRouteReservation: true,
      reservationSessionId: route.reservationSessionId ?? existing?.reservationSessionId,
      provider: normalized.provider,
      model: normalized.model,
      endpointUrl: normalized.endpointUrl,
      endpointSource: normalized.endpointSource,
      credentialEnv: normalized.credentialEnv,
      preferredInferenceApi: normalized.preferredInferenceApi,
      gatewayName: route.gatewayName,
      gatewayPort: undefined,
    };
    save(data);
    return true;
  });
}

/**
 * True only for an inference route reserved before sandbox registration.
 *
 * Structural parameter (only the two fields it reads) so display-layer entry
 * types that omit the rest of the durable registry shape can reuse this single
 * source of truth instead of re-deriving the predicate (#7609).
 */
export function isRouteOnlySandboxReservation(entry: {
  pendingRouteReservation?: true;
  createdAt?: string;
}): boolean {
  return entry.pendingRouteReservation === true && entry.createdAt === undefined;
}

export function isPendingReservationForSession(
  entry: SandboxEntry | null,
  sessionId: string | null | undefined,
): boolean {
  return (
    entry?.pendingRouteReservation === true &&
    Boolean(sessionId) &&
    entry.reservationSessionId === sessionId
  );
}

export function updateSandbox(name: string, updates: Partial<SandboxEntry>): boolean {
  return withLock(() => {
    const data = load();
    if (!data.sandboxes[name]) return false;
    if (Object.prototype.hasOwnProperty.call(updates, "name") && updates.name !== name) {
      return false;
    }
    Object.assign(data.sandboxes[name], updates);
    save(data);
    return true;
  });
}

/** Atomically capture and remove one registry row for a reversible lifecycle operation. */
export function removeSandboxWithReceipt(name: string): SandboxRemovalReceipt | null {
  return withLock(() => {
    const result = reversibleRemoval.removeSandboxFromRegistry(load(), name);
    if (!result.receipt) return null;
    save(result.registry);
    return result.receipt;
  });
}

export function removeSandbox(name: string): boolean {
  return removeSandboxWithReceipt(name) !== null;
}

/** Restore a captured row and reclaim its default only while its revision still matches. */
export function restoreSandboxEntry(
  entry: SandboxEntry,
  options: {
    defaultTransition?: {
      readonly from: string | null;
      readonly to: string;
      readonly expectedRevision: number;
    };
  } = {},
): void {
  withLock(() => {
    save(reversibleRemoval.restoreSandboxEntryInRegistry(load(), entry, options.defaultTransition));
  });
}

/** Restore a removed entry unless a recreate already registered its replacement. */
export function restoreSandboxEntryIfMissing(receipt: SandboxRemovalReceipt): boolean {
  return withLock(() => {
    const result = reversibleRemoval.restoreSandboxIfMissingInRegistry(load(), receipt);
    if (!result.restored) return false;
    save(result.registry);
    return result.restored;
  });
}

export function listSandboxes(): { sandboxes: SandboxEntry[]; defaultSandbox: string | null } {
  const data = load();
  return {
    sandboxes: Object.values(data.sandboxes),
    defaultSandbox: data.defaultSandbox,
  };
}

export function setDefault(name: string): boolean {
  return withLock(() => {
    const current = load();
    if (current.sandboxes[name]?.pendingRouteReservation === true) return false;
    const registry = reversibleRemoval.setDefaultInRegistry(current, name);
    if (!registry) return false;
    save(registry);
    return true;
  });
}

export function clearAll(): void {
  withLock(() => save(reversibleRemoval.clearRegistry(load())));
}

export function listExtraProviders(): string[] {
  return readExtraProviders(load());
}

export function addExtraProvider(name: string): boolean {
  if (!isValidExtraProviderName(name)) return false;
  return withLock(() => {
    const data = load();
    if (!applyAddExtraProvider(name, data)) return false;
    save(data);
    return true;
  });
}

export function removeExtraProvider(name: string): boolean {
  return withLock(() => {
    const data = load();
    if (!applyRemoveExtraProvider(name, data)) return false;
    save(data);
    return true;
  });
}

/** Return the list of custom policy entries recorded for a sandbox (never null). */
export function getCustomPolicies(name: string): CustomPolicyEntry[] {
  const data = load();
  return data.sandboxes[name]?.customPolicies ?? [];
}

/** Upsert a custom policy by name. Replaces any existing entry with the same name. */
export function addCustomPolicy(name: string, entry: CustomPolicyEntry): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = (sandbox.customPolicies ?? []).filter((p) => p.name !== entry.name);
    list.push({ ...entry, appliedAt: entry.appliedAt ?? new Date().toISOString() });
    sandbox.customPolicies = list;
    save(data);
    return true;
  });
}

/** Remove a custom policy by name. Returns true if an entry was removed. */
export function removeCustomPolicyByName(name: string, presetName: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = sandbox.customPolicies ?? [];
    const next = list.filter((p) => p.name !== presetName);
    if (next.length === list.length) return false;
    sandbox.customPolicies = next.length > 0 ? next : undefined;
    save(data);
    return true;
  });
}

/** Return the baseline exclusions recorded for a sandbox (never null). */
export function getBaselineExclusions(name: string): BaselineExclusionEntry[] {
  const data = load();
  return data.sandboxes[name]?.baselineExclusions ?? [];
}

/** Upsert a baseline exclusion by key. Replaces any existing entry for the key. */
export function addBaselineExclusion(name: string, entry: BaselineExclusionEntry): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    const list = (sandbox.baselineExclusions ?? []).filter((e) => e.key !== entry.key);
    list.push({ ...entry, acknowledgedAt: entry.acknowledgedAt ?? new Date().toISOString() });
    sandbox.baselineExclusions = list;
    save(data);
    return true;
  });
}

/** Remove a baseline exclusion by key. Returns true if an entry was removed. */
export function removeBaselineExclusion(name: string, key: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    const list = sandbox.baselineExclusions ?? [];
    const next = list.filter((e) => e.key !== key);
    if (next.length === list.length) return false;
    sandbox.baselineExclusions = next.length > 0 ? next : undefined;
    save(data);
    return true;
  });
}

/** Return the one in-flight baseline policy transaction for a sandbox. */
export function getBaselineExclusionTransition(name: string): BaselineExclusionTransition | null {
  const data = load();
  return data.sandboxes[name]?.baselineExclusionTransition ?? null;
}

/**
 * Persist a new cross-system transaction before changing the live policy.
 * Refuses to overwrite another pending transaction, even for the same key.
 */
export function beginBaselineExclusionTransition(
  name: string,
  transition: BaselineExclusionTransition,
): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    sandbox.baselineExclusionTransition = normalizeBaselineExclusionTransition(transition);
    save(data);
    return true;
  });
}

/**
 * Publish the durable intent represented by a completed live mutation and
 * clear its journal in the same registry-file replacement.
 */
export function commitBaselineExclusionTransition(name: string, id: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    const transition = sandbox?.baselineExclusionTransition;
    if (!sandbox || !transition || transition.id !== id) return false;
    if (transition.operation === "exclude") {
      const list = (sandbox.baselineExclusions ?? []).filter(
        (entry) => entry.key !== transition.exclusion.key,
      );
      list.push({
        ...transition.exclusion,
        acknowledgedAt: transition.exclusion.acknowledgedAt ?? new Date().toISOString(),
      });
      sandbox.baselineExclusions = list;
    } else {
      const list = sandbox.baselineExclusions ?? [];
      const committed = list.find((entry) => entry.key === transition.exclusion.key);
      // A restore may finalize only the exact durable exclusion it staged
      // against. Preserve the journal if another writer changed the record.
      if (!committed || !isDeepStrictEqual(committed, transition.exclusion)) return false;
      const next = list.filter((entry) => entry.key !== transition.exclusion.key);
      sandbox.baselineExclusions = next.length > 0 ? next : undefined;
    }
    sandbox.baselineExclusionTransition = undefined;
    save(data);
    return true;
  });
}

/** Roll back only the exact pending transaction, preserving committed intent. */
export function clearBaselineExclusionTransition(name: string, id: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition?.id !== id) return false;
    sandbox.baselineExclusionTransition = undefined;
    save(data);
    return true;
  });
}

export function getDisabledChannels(name: string): string[] {
  return getRegistryDisabledChannels(name, { load });
}

export function getConfiguredMessagingChannels(name: string): string[] {
  return getRegistryConfiguredMessagingChannels(name, { load });
}

export function setChannelDisabled(name: string, channel: string, disabled: boolean): boolean {
  return setRegistryChannelDisabled(name, channel, disabled, { load, save, withLock });
}
