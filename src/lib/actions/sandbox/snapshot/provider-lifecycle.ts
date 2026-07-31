// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { cloneAndDeepFreeze } from "../../../core/immutable";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
  RuntimeProviderRuntimeReceipt,
  RuntimeProviderSnapshotPreflightReceipt,
  RuntimeProviderSnapshotRestoreReceipt,
  RuntimeProviderSnapshotSurface,
} from "../../../onboard/runtime-provider/contract";
import {
  normalizeRuntimeProviderManagedProfileRestoreAuthority,
  normalizeRuntimeProviderRuntimeReceipt,
  normalizeRuntimeProviderSnapshotPreflightReceipt,
  normalizeRuntimeProviderSnapshotRestoreReceipt,
} from "../../../onboard/runtime-provider/registry";
import {
  cloneSandboxRuntimeSnapshot,
  SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type SandboxRuntimeSnapshot,
} from "../../../state/registry/runtime-snapshot";
import type { SandboxEntry } from "../../../state/registry/types";

type SupportedSnapshotSurface = Extract<RuntimeProviderSnapshotSurface, { supported: true }>;

export class SandboxSnapshotProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Sandbox snapshot provider failed: ${message}`, options);
    this.name = "SandboxSnapshotProviderError";
  }
}

/**
 * Provider facets are extension points, so readonly TypeScript annotations are
 * not a runtime trust boundary. Give every provider a detached, deeply frozen
 * copy and retain only separately normalized values in central orchestration.
 */

function requireSnapshotSurface(
  bundle: RuntimeProviderBundle,
  capability: keyof SupportedSnapshotSurface["capabilities"],
): SupportedSnapshotSurface {
  const surface = bundle.snapshot;
  if (
    surface.supported !== true ||
    surface.providerId !== bundle.identity.id ||
    surface.capabilities[capability] !== true
  ) {
    throw new SandboxSnapshotProviderError(
      `runtime provider '${bundle.identity.id}' does not support ${capability}`,
    );
  }
  return surface;
}

function requirePreflight(
  bundle: RuntimeProviderBundle,
  sandbox: SandboxEntry,
  operation: "backup" | "restore",
  value: unknown,
): RuntimeProviderSnapshotPreflightReceipt {
  const preflight = normalizeRuntimeProviderSnapshotPreflightReceipt(value);
  if (
    !preflight ||
    preflight.providerId !== bundle.identity.id ||
    preflight.operation !== operation ||
    preflight.sandboxName !== sandbox.name
  ) {
    throw new SandboxSnapshotProviderError(
      `runtime provider '${bundle.identity.id}' returned invalid ${operation} preflight authority`,
    );
  }
  return preflight;
}

function requireRuntimeReceipt(
  bundle: RuntimeProviderBundle,
  value: unknown,
): RuntimeProviderRuntimeReceipt {
  const receipt = normalizeRuntimeProviderRuntimeReceipt(value);
  if (!receipt || receipt.providerId !== bundle.identity.id) {
    throw new SandboxSnapshotProviderError(
      `runtime provider '${bundle.identity.id}' returned unrepresentable runtime state`,
    );
  }
  return receipt;
}

function requireRestoreReceipt(
  bundle: RuntimeProviderBundle,
  sandbox: SandboxEntry,
  authority: RuntimeProviderManagedProfileRestoreAuthority,
  preflight: RuntimeProviderSnapshotPreflightReceipt,
  source: SandboxRuntimeSnapshot,
  value: unknown,
): RuntimeProviderSnapshotRestoreReceipt {
  const receipt = normalizeRuntimeProviderSnapshotRestoreReceipt(value);
  if (
    !receipt ||
    receipt.providerId !== bundle.identity.id ||
    receipt.sandboxName !== sandbox.name ||
    receipt.managedProfile.agent !== authority.agent ||
    receipt.managedProfile.profileFingerprint !== authority.profileFingerprint ||
    receipt.lifecycleState !== preflight.lifecycleState ||
    receipt.lifecycleGeneration !== preflight.lifecycleGeneration ||
    !isDeepStrictEqual(receipt.runtime.acceleration, source.runtime.acceleration)
  ) {
    throw new SandboxSnapshotProviderError(
      `runtime provider '${bundle.identity.id}' returned invalid managed restore proof`,
    );
  }
  return receipt;
}

/**
 * Capture the complete provider-neutral snapshot state. Both provider calls
 * occur inside the caller's quiescence lock; the provider re-observes runtime
 * identity at capture so a stale preflight can never be persisted.
 */
export function captureSandboxRuntimeSnapshot(
  bundle: RuntimeProviderBundle,
  sandbox: SandboxEntry,
): SandboxRuntimeSnapshot {
  const surface = requireSnapshotSurface(bundle, "backup");
  const providerSandbox = cloneAndDeepFreeze(sandbox);
  const preflight = requirePreflight(
    bundle,
    sandbox,
    "backup",
    surface.preflight("backup", providerSandbox),
  );
  const immutablePreflight = cloneAndDeepFreeze(preflight);
  const runtime = requireRuntimeReceipt(
    bundle,
    surface.capture(providerSandbox, immutablePreflight),
  );
  return cloneAndDeepFreeze({
    schemaVersion: SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    providerId: bundle.identity.id,
    providerHandle: immutablePreflight.providerHandle,
    lifecycleState: immutablePreflight.lifecycleState,
    lifecycleGeneration: immutablePreflight.lifecycleGeneration,
    runtime: cloneAndDeepFreeze(runtime),
  });
}

export interface PreparedSandboxRuntimeRestore {
  readonly phase: "preflighted";
  readonly targetProviderId: string;
  readonly targetSandboxName: string;
  readonly source: SandboxRuntimeSnapshot;
  readonly preflight: RuntimeProviderSnapshotPreflightReceipt;
  readonly managedProfile: RuntimeProviderManagedProfileRestoreAuthority;
}

export interface ValidatedSandboxRuntimeRestore {
  readonly phase: "validated";
  readonly targetProviderId: string;
  readonly targetSandboxName: string;
  readonly source: SandboxRuntimeSnapshot;
  readonly restoreReceipt: RuntimeProviderSnapshotRestoreReceipt;
}

/**
 * Perform the read-only restore preflight before a force-delete or filesystem
 * mutation. Source provider handles remain opaque; PR3.8 self-restore requires
 * the exact owning provider, while cross-provider rebinding remains deferred.
 */
export function prepareSandboxRuntimeRestore(
  bundle: RuntimeProviderBundle,
  target: SandboxEntry,
  sourceValue: unknown,
  managedProfileValue: unknown,
): PreparedSandboxRuntimeRestore {
  const source = cloneSandboxRuntimeSnapshot(sourceValue);
  if (!source) {
    throw new SandboxSnapshotProviderError("snapshot runtime state is invalid");
  }
  if (source.providerId !== bundle.identity.id) {
    throw new SandboxSnapshotProviderError(
      `snapshot runtime provider '${source.providerId}' does not match target provider '${bundle.identity.id}'`,
    );
  }
  const surface = requireSnapshotSurface(bundle, "restore");
  const providerTarget = cloneAndDeepFreeze(target);
  const immutableSource = cloneAndDeepFreeze(source);
  const managedProfile =
    normalizeRuntimeProviderManagedProfileRestoreAuthority(managedProfileValue);
  if (!managedProfile) {
    throw new SandboxSnapshotProviderError("managed profile restore authority is invalid");
  }
  const preflight = requirePreflight(
    bundle,
    target,
    "restore",
    surface.preflight("restore", providerTarget),
  );
  if (preflight.lifecycleState !== source.lifecycleState) {
    throw new SandboxSnapshotProviderError(
      `target '${target.name}' cannot represent the snapshot lifecycle state`,
    );
  }
  const immutablePreflight = cloneAndDeepFreeze(preflight);
  const immutableManagedProfile = cloneAndDeepFreeze(managedProfile);
  surface.validateRestore(
    providerTarget,
    immutablePreflight,
    immutableSource,
    immutableManagedProfile,
  );
  return cloneAndDeepFreeze({
    phase: "preflighted" as const,
    targetProviderId: bundle.identity.id,
    targetSandboxName: target.name,
    source: immutableSource,
    preflight: immutablePreflight,
    managedProfile: immutableManagedProfile,
  });
}

function normalizePreparedRestore(
  bundle: RuntimeProviderBundle,
  target: SandboxEntry,
  prepared: PreparedSandboxRuntimeRestore,
): PreparedSandboxRuntimeRestore {
  const source = cloneSandboxRuntimeSnapshot(prepared.source);
  const preflight = normalizeRuntimeProviderSnapshotPreflightReceipt(prepared.preflight);
  const managedProfile = normalizeRuntimeProviderManagedProfileRestoreAuthority(
    prepared.managedProfile,
  );
  if (
    prepared.phase !== "preflighted" ||
    prepared.targetProviderId !== bundle.identity.id ||
    prepared.targetSandboxName !== target.name ||
    !source ||
    source.providerId !== bundle.identity.id ||
    !preflight ||
    preflight.providerId !== bundle.identity.id ||
    preflight.operation !== "restore" ||
    preflight.sandboxName !== target.name ||
    !managedProfile
  ) {
    throw new SandboxSnapshotProviderError("restore preflight authority is stale");
  }
  return cloneAndDeepFreeze({
    phase: "preflighted" as const,
    targetProviderId: bundle.identity.id,
    targetSandboxName: target.name,
    source: cloneAndDeepFreeze(source),
    preflight: cloneAndDeepFreeze(preflight),
    managedProfile: cloneAndDeepFreeze(managedProfile),
  });
}

/**
 * Invoke the owning provider after filesystem restoration. The provider
 * consumes its exact preflight authority, proves the managed profile is live,
 * and returns a normalized runtime/restore receipt; central orchestration
 * never interprets either opaque handle.
 */
export function confirmSandboxRuntimeRestore(
  bundle: RuntimeProviderBundle,
  target: SandboxEntry,
  prepared: PreparedSandboxRuntimeRestore,
): ValidatedSandboxRuntimeRestore {
  const authority = normalizePreparedRestore(bundle, target, prepared);
  const surface = requireSnapshotSurface(bundle, "restore");
  const providerTarget = cloneAndDeepFreeze(target);
  const restoreReceipt = requireRestoreReceipt(
    bundle,
    target,
    authority.managedProfile,
    authority.preflight,
    authority.source,
    surface.restore(
      providerTarget,
      authority.preflight,
      authority.source,
      authority.managedProfile,
    ),
  );
  return cloneAndDeepFreeze({
    phase: "validated" as const,
    targetProviderId: bundle.identity.id,
    targetSandboxName: target.name,
    source: authority.source,
    restoreReceipt: cloneAndDeepFreeze(restoreReceipt),
  });
}
