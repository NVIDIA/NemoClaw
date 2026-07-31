// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  value: unknown,
): RuntimeProviderSnapshotRestoreReceipt {
  const receipt = normalizeRuntimeProviderSnapshotRestoreReceipt(value);
  if (
    !receipt ||
    receipt.providerId !== bundle.identity.id ||
    receipt.sandboxName !== sandbox.name ||
    receipt.managedProfile.agent !== authority.agent ||
    receipt.managedProfile.profileFingerprint !== authority.profileFingerprint
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
  const preflight = requirePreflight(
    bundle,
    sandbox,
    "backup",
    surface.preflight("backup", sandbox),
  );
  const runtime = requireRuntimeReceipt(bundle, surface.capture(sandbox, preflight));
  return {
    schemaVersion: SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    providerId: bundle.identity.id,
    providerHandle: preflight.providerHandle,
    lifecycleState: preflight.lifecycleState,
    lifecycleGeneration: preflight.lifecycleGeneration,
    runtime,
  };
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
  const managedProfile =
    normalizeRuntimeProviderManagedProfileRestoreAuthority(managedProfileValue);
  if (!managedProfile) {
    throw new SandboxSnapshotProviderError("managed profile restore authority is invalid");
  }
  const preflight = requirePreflight(
    bundle,
    target,
    "restore",
    surface.preflight("restore", target),
  );
  if (preflight.lifecycleState !== source.lifecycleState) {
    throw new SandboxSnapshotProviderError(
      `target '${target.name}' cannot represent the snapshot lifecycle state`,
    );
  }
  surface.validateRestore(target, preflight, source, managedProfile);
  return Object.freeze({
    phase: "preflighted" as const,
    targetProviderId: bundle.identity.id,
    targetSandboxName: target.name,
    source,
    preflight,
    managedProfile,
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
  if (
    prepared.phase !== "preflighted" ||
    prepared.targetProviderId !== bundle.identity.id ||
    prepared.targetSandboxName !== target.name
  ) {
    throw new SandboxSnapshotProviderError("restore preflight authority is stale");
  }
  const surface = requireSnapshotSurface(bundle, "restore");
  const restoreReceipt = requireRestoreReceipt(
    bundle,
    target,
    prepared.managedProfile,
    surface.restore(target, prepared.preflight, prepared.source, prepared.managedProfile),
  );
  return Object.freeze({
    phase: "validated" as const,
    targetProviderId: bundle.identity.id,
    targetSandboxName: target.name,
    source: prepared.source,
    restoreReceipt,
  });
}
