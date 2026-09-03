// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { cloneAndDeepFreeze } from "../../../core/immutable";
import { REPOSITORY_ROOT } from "../../../core/repository-root";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../../messaging/provider-profile";
import { isValidName, isValidProviderName } from "../../../name-validation";
import { reportsExactProviderNotFound } from "../../../adapters/openshell/provider-diagnostic-cli";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  parseGatewayProviderMetadata,
} from "../../../onboard/gateway-provider-metadata";
import type { ManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import { normalizeRuntimeProviderIdentity } from "../../../onboard/runtime-provider/registry";
import { deleteProviderWithRecovery } from "../../../onboard/sandbox-provider-cleanup";
import type { PreparedManagedWorkloadCloneHandoff } from "../../../onboard/workload/clone";
import {
  captureSandboxRebuildAuthority,
  type SandboxRebuildAuthority,
  sandboxRebuildAuthorityMatchesEntry,
} from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";

const PROVIDER_PROBE_DIAGNOSTIC_LIMIT = 64 * 1024;
export const MANAGED_CLONE_PROVIDER_CREATE_TIMEOUT_MS = 30_000;
const PROVIDER_PROBE_TIMEOUT_MS = 5_000;
const PROVIDER_TYPE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const PROVIDER_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/u;

export type ManagedCloneProviderCommandResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: unknown;
  readonly signal?: NodeJS.Signals | string | null;
};

export type ManagedCloneProviderRunner = (
  args: string[],
  options?: {
    readonly [key: string]: unknown;
    readonly ignoreError?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly maxBuffer?: number;
    readonly suppressOutput?: boolean;
    readonly stdio?: ["ignore", "ignore" | "pipe", "ignore" | "pipe"];
    readonly timeout?: number;
  },
) => ManagedCloneProviderCommandResult;

export interface ManagedCloneProviderBinding {
  readonly providerName: string;
  readonly providerType: string;
  readonly providerEnvKey: string;
  /** Provider-neutral contribution owner, for diagnostics only. */
  readonly source: string;
}

export interface PreparedManagedCloneProvider {
  readonly binding: ManagedCloneProviderBinding;
  readonly action: "create" | "reuse-destination-owned";
}

export interface PreparedManagedCloneProviderTransaction {
  readonly schemaVersion: 1;
  readonly phase: "prepared";
  readonly transactionId: string;
  readonly providerId: string;
  readonly sourceSandboxName: string;
  readonly destinationSandboxName: string;
  readonly sourceRegistryAuthority: SandboxRebuildAuthority;
  readonly snapshotRestoreAuthority: sandboxState.SnapshotRestoreAuthority;
  readonly destinationRegistryAuthority?: SandboxRebuildAuthority;
  readonly providers: readonly PreparedManagedCloneProvider[];
}

export interface ManagedCloneProviderOwnershipReceipt {
  readonly binding: ManagedCloneProviderBinding;
  readonly disposition: "created" | "reused-destination-owned";
}

export interface ManagedCloneProviderTransactionReceipt {
  readonly schemaVersion: 1;
  readonly phase: "materialized";
  readonly transactionId: string;
  readonly providerId: string;
  readonly destinationSandboxName: string;
  readonly providers: readonly ManagedCloneProviderOwnershipReceipt[];
}

export type ManagedCloneProviderCleanupOutcome =
  | "already-cleaned"
  | "already-missing"
  | "deleted"
  | "delete-failed"
  | "drift-preserved"
  | "inspection-failed"
  | "reused-preserved";

export interface ManagedCloneProviderCleanupResult {
  readonly status: "complete" | "partial";
  readonly providers: readonly {
    readonly providerName: string;
    readonly outcome: ManagedCloneProviderCleanupOutcome;
  }[];
}

type CaptureSnapshotRestoreAuthority = typeof sandboxState.captureSnapshotRestoreAuthority;
type ReadSandbox = (sandboxName: string) => SandboxEntry | null;

export class ManagedCloneProviderTransactionError extends Error {
  readonly partialReceipt?: ManagedCloneProviderTransactionReceipt;
  readonly rollback?: ManagedCloneProviderCleanupResult;

  constructor(
    message: string,
    options: ErrorOptions & {
      readonly partialReceipt?: ManagedCloneProviderTransactionReceipt;
      readonly rollback?: ManagedCloneProviderCleanupResult;
    } = {},
  ) {
    super(`Managed clone provider transaction failed: ${message}`, options);
    this.name = "ManagedCloneProviderTransactionError";
    this.partialReceipt = options.partialReceipt;
    this.rollback = options.rollback;
  }
}

const issuedReceipts = new WeakSet<object>();
const completedCleanup = new WeakMap<object, Set<string>>();

function fail(message: string, cause?: unknown): never {
  throw new ManagedCloneProviderTransactionError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function commandStreamText(value: string | Buffer | null | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");
}

type ProviderInspection =
  | { readonly kind: "collision" }
  | { readonly kind: "exact" }
  | { readonly kind: "missing" };

function inspectProvider(
  binding: ManagedCloneProviderBinding,
  runOpenshell: ManagedCloneProviderRunner,
): ProviderInspection {
  const result = runOpenshell(["provider", "get", binding.providerName], {
    ignoreError: true,
    maxBuffer: PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
    suppressOutput: true,
    timeout: PROVIDER_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.signal || result.status !== 0) {
    const output = `${commandStreamText(result.stdout)}\n${commandStreamText(result.stderr)}`;
    if (
      !result.error &&
      !result.signal &&
      result.status === 1 &&
      reportsExactProviderNotFound(output, binding.providerName, PROVIDER_PROBE_DIAGNOSTIC_LIMIT)
    ) {
      return { kind: "missing" };
    }
    fail(
      `could not prove whether provider '${binding.providerName}' exists; ` +
        "refusing destination mutation",
    );
  }

  const metadata = parseGatewayProviderMetadata(
    `${commandStreamText(result.stdout)}\n${commandStreamText(result.stderr)}`,
  );
  return matchesGatewayCredentialOnlyProviderBinding(metadata, {
    name: binding.providerName,
    type: binding.providerType,
    credentialKey: binding.providerEnvKey,
  })
    ? { kind: "exact" }
    : { kind: "collision" };
}

function validatedBinding(binding: ManagedCloneProviderBinding): ManagedCloneProviderBinding {
  if (!isValidProviderName(binding.providerName)) {
    fail(`provider name '${binding.providerName}' is invalid`);
  }
  if (!PROVIDER_TYPE_PATTERN.test(binding.providerType)) {
    fail(`provider '${binding.providerName}' has an invalid type`);
  }
  if (!PROVIDER_ENV_KEY_PATTERN.test(binding.providerEnvKey)) {
    fail(`provider '${binding.providerName}' has an invalid credential binding`);
  }
  if (
    typeof binding.source !== "string" ||
    binding.source.trim() === "" ||
    binding.source !== binding.source.trim() ||
    Buffer.byteLength(binding.source, "utf8") > 128
  ) {
    fail(`provider '${binding.providerName}' has an invalid contribution owner`);
  }
  return { ...binding };
}

function mergeBindings(
  bindings: readonly ManagedCloneProviderBinding[],
): readonly ManagedCloneProviderBinding[] {
  const merged = new Map<string, ManagedCloneProviderBinding>();
  for (const candidate of bindings) {
    const binding = validatedBinding(candidate);
    const existing = merged.get(binding.providerName);
    if (
      existing &&
      (existing.providerType !== binding.providerType ||
        existing.providerEnvKey !== binding.providerEnvKey)
    ) {
      fail(`provider '${binding.providerName}' has conflicting desired bindings`);
    }
    if (!existing) merged.set(binding.providerName, binding);
  }
  return [...merged.values()];
}

function activeMessagingCredentialBindings(
  plan: SandboxMessagingPlan | null | undefined,
  expectedSandboxName: string,
  expectedAgent: string | null | undefined,
): readonly SandboxMessagingPlan["credentialBindings"][number][] {
  if (!plan) return [];
  if (
    plan.sandboxName !== expectedSandboxName ||
    (expectedAgent !== null && expectedAgent !== undefined && plan.agent !== expectedAgent)
  ) {
    fail(`messaging provider ownership does not belong to '${expectedSandboxName}'`);
  }
  const activeChannels = new Set(
    plan.channels
      .filter(
        (channel) =>
          channel.active && !channel.disabled && !plan.disabledChannels.includes(channel.channelId),
      )
      .map((channel) => channel.channelId),
  );
  return plan.credentialBindings.filter((binding) => activeChannels.has(binding.channelId));
}

function applicationBindings(input: {
  readonly profile: ManagedStartupProfile;
  readonly messagingPlan: SandboxMessagingPlan | null | undefined;
  readonly sandboxName: string;
}): readonly ManagedCloneProviderBinding[] {
  const bindings: ManagedCloneProviderBinding[] = activeMessagingCredentialBindings(
    input.messagingPlan,
    input.sandboxName,
    input.profile.agent,
  ).map((binding) => ({
    providerName: binding.providerName,
    providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    providerEnvKey: binding.providerEnvKey,
    source: "messaging",
  }));
  if (
    input.profile.agentConfig.agent === "openclaw" ||
    input.profile.agentConfig.agent === "hermes"
  ) {
    const webSearch = input.profile.agentConfig.webSearch;
    if (webSearch.enabled) {
      bindings.push({
        providerName: `${input.sandboxName}-${webSearch.provider}-search`,
        providerType:
          input.profile.agent === "hermes" && webSearch.provider === "tavily"
            ? "nemoclaw-hermes-tavily"
            : webSearch.provider,
        providerEnvKey: webSearch.provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
        source: "web-search",
      });
    }
  }
  return mergeBindings(bindings);
}

function destinationOwnedBindings(entry: SandboxEntry): readonly ManagedCloneProviderBinding[] {
  const bindings: ManagedCloneProviderBinding[] = activeMessagingCredentialBindings(
    entry.messaging?.plan,
    entry.name,
    entry.agent,
  ).map((binding) => ({
    providerName: binding.providerName,
    providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    providerEnvKey: binding.providerEnvKey,
    source: "messaging",
  }));
  if (entry.webSearchEnabled === true && entry.webSearchProvider) {
    bindings.push({
      providerName: `${entry.name}-${entry.webSearchProvider}-search`,
      providerType:
        entry.agent === "hermes" && entry.webSearchProvider === "tavily"
          ? "nemoclaw-hermes-tavily"
          : entry.webSearchProvider,
      providerEnvKey: entry.webSearchProvider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
      source: "web-search",
    });
  }
  return mergeBindings(bindings);
}

function sameBinding(
  left: ManagedCloneProviderBinding,
  right: ManagedCloneProviderBinding,
): boolean {
  return (
    left.providerName === right.providerName &&
    left.providerType === right.providerType &&
    left.providerEnvKey === right.providerEnvKey
  );
}

function hasCredential(environment: NodeJS.ProcessEnv, envKey: string): boolean {
  const value = environment[envKey];
  return typeof value === "string" && value.replace(/\r/gu, "").trim().length > 0;
}

function requireTransactionId(value: string | undefined): string {
  const transactionId = value ?? randomBytes(16).toString("hex");
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) fail("transaction identity is invalid");
  return transactionId;
}

type CloneProviderHandoff = Pick<
  PreparedManagedWorkloadCloneHandoff,
  | "destinationSandboxName"
  | "messaging"
  | "providerId"
  | "rebound"
  | "snapshotRestoreAuthority"
  | "sourceRegistryAuthority"
  | "sourceSandboxName"
>;

/**
 * Build one inert provider transaction from the deep-frozen clone handoff.
 * Existing exact providers are reusable only when the destination registry
 * independently proves the same logical binding. They are never rewritten:
 * credential rotation remains a separate explicit operation with its own
 * recovery contract.
 */
export function prepareManagedCloneProviderTransaction(input: {
  readonly handoff: CloneProviderHandoff;
  readonly destination: SandboxEntry | null;
  readonly additionalBindings?: readonly ManagedCloneProviderBinding[];
  readonly resolveAdditionalDestinationOwnedBindings?: (
    destination: Readonly<SandboxEntry>,
  ) => readonly ManagedCloneProviderBinding[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly runOpenshell: ManagedCloneProviderRunner;
  readonly transactionId?: string;
}): PreparedManagedCloneProviderTransaction {
  const destinationSandboxName = input.handoff.destinationSandboxName;
  if (
    !isValidName(input.handoff.sourceSandboxName) ||
    !isValidName(destinationSandboxName) ||
    input.handoff.sourceSandboxName === destinationSandboxName
  ) {
    fail("clone sandbox identity is invalid");
  }
  if (
    input.handoff.sourceRegistryAuthority.sandboxName !== input.handoff.sourceSandboxName ||
    input.handoff.sourceRegistryAuthority.providerId !== input.handoff.providerId
  ) {
    fail("clone handoff registry authority does not match its provider and source identity");
  }
  if (input.destination && input.destination.name !== destinationSandboxName) {
    fail("destination registry authority names a different sandbox");
  }
  const destinationProviderId = input.destination
    ? normalizeRuntimeProviderIdentity(input.destination.openshellDriver)
    : null;
  if (destinationProviderId !== null && destinationProviderId !== input.handoff.providerId) {
    fail("destination registry authority uses a different runtime provider");
  }
  const desired = mergeBindings([
    ...applicationBindings({
      profile: input.handoff.rebound.profile,
      messagingPlan: input.handoff.messaging?.plan,
      sandboxName: destinationSandboxName,
    }),
    ...(input.additionalBindings ?? []),
  ]);
  const owned = input.destination
    ? mergeBindings([
        ...destinationOwnedBindings(input.destination),
        ...(input.resolveAdditionalDestinationOwnedBindings?.(input.destination) ?? []),
      ])
    : [];
  const environment = input.environment ?? process.env;
  const providers: PreparedManagedCloneProvider[] = [];
  for (const binding of desired) {
    if (!hasCredential(environment, binding.providerEnvKey)) {
      fail(
        `${binding.source} provider '${binding.providerName}' requires an explicit clone ` +
          `credential in ${binding.providerEnvKey}`,
      );
    }
    const inspection = inspectProvider(binding, input.runOpenshell);
    if (inspection.kind === "collision") {
      fail(`provider '${binding.providerName}' has an incompatible live binding`);
    }
    if (inspection.kind === "exact") {
      if (!input.destination || !owned.some((candidate) => sameBinding(candidate, binding))) {
        fail(
          `provider '${binding.providerName}' exists without exact destination ownership; ` +
            "refusing credential reuse",
        );
      }
      providers.push({ binding, action: "reuse-destination-owned" });
      continue;
    }
    providers.push({ binding, action: "create" });
  }

  let destinationRegistryAuthority: SandboxRebuildAuthority | undefined;
  if (input.destination && destinationProviderId !== null) {
    try {
      destinationRegistryAuthority = captureSandboxRebuildAuthority(
        input.destination,
        destinationProviderId,
      );
    } catch (error) {
      fail("destination has no exact managed registry authority", error);
    }
  }

  return cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    phase: "prepared" as const,
    transactionId: requireTransactionId(input.transactionId),
    providerId: input.handoff.providerId,
    sourceSandboxName: input.handoff.sourceSandboxName,
    destinationSandboxName,
    sourceRegistryAuthority: structuredClone(input.handoff.sourceRegistryAuthority),
    snapshotRestoreAuthority: structuredClone(input.handoff.snapshotRestoreAuthority),
    ...(destinationRegistryAuthority === undefined ? {} : { destinationRegistryAuthority }),
    providers,
  });
}

/** Revalidate every durable authority at the last safe edge before mutation. */
export function revalidateManagedCloneMutationAuthority(
  prepared: PreparedManagedCloneProviderTransaction,
  input: {
    readonly readSandbox: ReadSandbox;
    readonly captureSnapshotRestoreAuthority?: CaptureSnapshotRestoreAuthority;
  },
): void {
  const source = input.readSandbox(prepared.sourceSandboxName);
  if (!sandboxRebuildAuthorityMatchesEntry(prepared.sourceRegistryAuthority, source)) {
    fail("source registry authority changed before mutation");
  }
  const currentDestination = input.readSandbox(prepared.destinationSandboxName);
  if (prepared.destinationRegistryAuthority) {
    if (
      !sandboxRebuildAuthorityMatchesEntry(
        prepared.destinationRegistryAuthority,
        currentDestination,
      )
    ) {
      fail("destination registry authority changed before mutation");
    }
  } else if (currentDestination !== null) {
    fail("destination appeared after clone preflight");
  }
  const capture =
    input.captureSnapshotRestoreAuthority ?? sandboxState.captureSnapshotRestoreAuthority;
  const content = capture(prepared.snapshotRestoreAuthority.backupPath);
  if (!content || !isDeepStrictEqual(content, prepared.snapshotRestoreAuthority)) {
    fail("selected snapshot content changed before mutation");
  }
}

function issueReceipt(
  prepared: PreparedManagedCloneProviderTransaction,
  providers: readonly ManagedCloneProviderOwnershipReceipt[],
): ManagedCloneProviderTransactionReceipt {
  const receipt = cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    phase: "materialized" as const,
    transactionId: prepared.transactionId,
    providerId: prepared.providerId,
    destinationSandboxName: prepared.destinationSandboxName,
    providers: providers.map((provider) => ({
      binding: { ...provider.binding },
      disposition: provider.disposition,
    })),
  });
  issuedReceipts.add(receipt);
  completedCleanup.set(receipt, new Set());
  return receipt;
}

/**
 * Materialize missing providers under one process-local ownership ledger.
 * A non-zero create followed by an exact provider is explicitly ambiguous:
 * it is preserved and never claimed by this transaction.
 */
export function provisionManagedCloneProviderTransaction(
  prepared: PreparedManagedCloneProviderTransaction,
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly runOpenshell: ManagedCloneProviderRunner;
    readonly readSandbox: ReadSandbox;
    readonly captureSnapshotRestoreAuthority?: CaptureSnapshotRestoreAuthority;
    /** Provider-neutral apply-time credential substitution (for host brokers). */
    readonly resolveCredential?: (
      binding: ManagedCloneProviderBinding,
      environment: NodeJS.ProcessEnv,
    ) => string | null | undefined;
  },
): ManagedCloneProviderTransactionReceipt {
  const environment = input.environment ?? process.env;
  const confirmed: ManagedCloneProviderOwnershipReceipt[] = [];
  try {
    // Fence every shared gateway mutation, including provider profile import.
    revalidateManagedCloneMutationAuthority(prepared, input);
    if (
      prepared.providers.some(
        (provider) => provider.binding.providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      )
    ) {
      ensureMessagingCredentialProviderProfile({
        root: REPOSITORY_ROOT,
        runOpenshell: input.runOpenshell,
      });
    }
    for (const provider of prepared.providers) {
      revalidateManagedCloneMutationAuthority(prepared, input);
      const current = inspectProvider(provider.binding, input.runOpenshell);
      if (provider.action === "reuse-destination-owned") {
        if (current.kind !== "exact") {
          fail(`destination-owned provider '${provider.binding.providerName}' changed before use`);
        }
        confirmed.push({
          binding: provider.binding,
          disposition: "reused-destination-owned",
        });
        continue;
      }
      if (current.kind !== "missing") {
        fail(`provider '${provider.binding.providerName}' appeared after preflight`);
      }
      const resolved = input.resolveCredential?.(provider.binding, environment);
      const credential = (
        resolved === undefined ? environment[provider.binding.providerEnvKey] : resolved
      )
        ?.replace(/\r/gu, "")
        .trim();
      if (!credential) {
        fail(`credential ${provider.binding.providerEnvKey} disappeared before provider creation`);
      }
      let result: ManagedCloneProviderCommandResult;
      try {
        result = input.runOpenshell(
          [
            "provider",
            "create",
            "--name",
            provider.binding.providerName,
            "--type",
            provider.binding.providerType,
            "--credential",
            provider.binding.providerEnvKey,
          ],
          {
            ignoreError: true,
            env: { [provider.binding.providerEnvKey]: credential },
            maxBuffer: PROVIDER_PROBE_DIAGNOSTIC_LIMIT,
            stdio: ["ignore", "pipe", "pipe"],
            suppressOutput: true,
            timeout: MANAGED_CLONE_PROVIDER_CREATE_TIMEOUT_MS,
          },
        );
      } catch (error) {
        // A thrown child-process adapter can still mean the gateway committed
        // the create. Reconcile by exact metadata and preserve it as unowned.
        result = { status: null, error };
      }
      const reconciled = inspectProvider(provider.binding, input.runOpenshell);
      if (result.status !== 0 || result.error || result.signal) {
        const state = reconciled.kind === "exact" ? "exact but unowned" : reconciled.kind;
        fail(
          `create for provider '${provider.binding.providerName}' had an ambiguous result ` +
            `(${state}); preserving the observed provider`,
        );
      }
      if (reconciled.kind !== "exact") {
        fail(
          `provider '${provider.binding.providerName}' was not exact after successful create; ` +
            "preserving the observed state",
        );
      }
      confirmed.push({ binding: provider.binding, disposition: "created" });
    }
    return issueReceipt(prepared, confirmed);
  } catch (cause) {
    const partialReceipt = issueReceipt(prepared, confirmed);
    const rollback = cleanupManagedCloneProviderTransaction(partialReceipt, input.runOpenshell);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ManagedCloneProviderTransactionError(detail, {
      cause,
      partialReceipt,
      rollback,
    });
  }
}

/**
 * Idempotently clean only providers confirmed by this exact in-process
 * receipt. Once a name is cleaned, the ledger never re-inspects it, preventing
 * a repeated cleanup from deleting a later same-name provider.
 */
export function cleanupManagedCloneProviderTransaction(
  receipt: ManagedCloneProviderTransactionReceipt,
  runOpenshell: ManagedCloneProviderRunner,
): ManagedCloneProviderCleanupResult {
  if (!issuedReceipts.has(receipt)) {
    fail("cleanup requires the exact process-local ownership receipt");
  }
  const cleaned = completedCleanup.get(receipt);
  if (!cleaned) fail("cleanup ownership ledger is unavailable");
  const outcomes: Array<{
    providerName: string;
    outcome: ManagedCloneProviderCleanupOutcome;
  }> = [];
  for (const provider of [...receipt.providers].reverse()) {
    const providerName = provider.binding.providerName;
    if (provider.disposition === "reused-destination-owned") {
      outcomes.push({ providerName, outcome: "reused-preserved" });
      continue;
    }
    if (cleaned.has(providerName)) {
      outcomes.push({ providerName, outcome: "already-cleaned" });
      continue;
    }
    let inspection: ProviderInspection;
    try {
      inspection = inspectProvider(provider.binding, runOpenshell);
    } catch {
      outcomes.push({ providerName, outcome: "inspection-failed" });
      continue;
    }
    if (inspection.kind === "missing") {
      cleaned.add(providerName);
      outcomes.push({ providerName, outcome: "already-missing" });
      continue;
    }
    if (inspection.kind === "collision") {
      outcomes.push({ providerName, outcome: "drift-preserved" });
      continue;
    }
    const deletion = deleteProviderWithRecovery(providerName, {
      runOpenshell,
      allowedSandboxes: [receipt.destinationSandboxName],
    });
    if (!deletion.ok) {
      outcomes.push({ providerName, outcome: "delete-failed" });
      continue;
    }
    try {
      if (inspectProvider(provider.binding, runOpenshell).kind !== "missing") {
        outcomes.push({ providerName, outcome: "delete-failed" });
        continue;
      }
    } catch {
      outcomes.push({ providerName, outcome: "inspection-failed" });
      continue;
    }
    cleaned.add(providerName);
    outcomes.push({ providerName, outcome: "deleted" });
  }
  return cloneAndDeepFreeze({
    status: outcomes.every((result) =>
      ["already-cleaned", "already-missing", "deleted", "reused-preserved"].includes(
        result.outcome,
      ),
    )
      ? ("complete" as const)
      : ("partial" as const),
    providers: outcomes,
  });
}
