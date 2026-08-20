// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fingerprintManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
} from "../../../onboard/runtime-provider/contract";
import { normalizeRuntimeProviderIdentity } from "../../../onboard/runtime-provider/registry";
import {
  type ManagedWorkloadAuthority,
  readManagedWorkloadAuthority,
} from "../../../onboard/workload/authority";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";

export interface ManagedSnapshotProfileSource {
  readonly sandboxName: string;
  readonly agentType: string;
  readonly imageTag?: string | null;
  readonly fromDockerfile?: string | null;
  readonly workload?: SandboxWorkloadReceipt;
}

export interface ManagedSnapshotProfileRestorePlan {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly sourceSandboxName: string;
  readonly targetSandboxName: string;
  readonly authority: ManagedWorkloadAuthority;
  readonly providerRestoreAuthority: RuntimeProviderManagedProfileRestoreAuthority;
}

export class ManagedSnapshotProfileRestoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed snapshot profile restore failed: ${message}`, options);
    this.name = "ManagedSnapshotProfileRestoreError";
  }
}

/**
 * Reconstruct and validate the secret-free managed startup authority stored in
 * a snapshot. No mutable release catalog or current image alias is consulted.
 */
export function readManagedSnapshotProfileAuthority(
  source: ManagedSnapshotProfileSource,
): ManagedWorkloadAuthority | null {
  try {
    return readManagedWorkloadAuthority({
      agent: source.agentType,
      fromDockerfile: source.fromDockerfile ?? null,
      imageTag:
        source.imageTag ??
        (source.workload?.kind === "managed-image" ? source.workload.reference : null),
      workload: source.workload,
    });
  } catch (error) {
    throw new ManagedSnapshotProfileRestoreError(
      `snapshot '${source.sandboxName}' has invalid managed workload authority`,
      { cause: error },
    );
  }
}

/**
 * Validate an in-place managed-profile restore against the selected provider
 * and both durable workload authorities. A same-name rebuild may replace the
 * managed image and startup profile before state is restored, so runtime
 * completion is bound to the replacement profile. Cross-sandbox rebind and
 * activation remain owned by the later clone transaction.
 */
export function prepareManagedSnapshotProfileRestore(
  source: ManagedSnapshotProfileSource,
  target: SandboxEntry,
  provider: RuntimeProviderBundle,
): ManagedSnapshotProfileRestorePlan | null {
  const sourceAuthority = readManagedSnapshotProfileAuthority(source);
  if (!sourceAuthority) return null;

  const targetProviderId = normalizeRuntimeProviderIdentity(target.openshellDriver);
  if (
    targetProviderId !== provider.identity.id ||
    provider.snapshot.providerId !== provider.identity.id
  ) {
    throw new ManagedSnapshotProfileRestoreError(
      `target '${target.name}' does not belong to provider '${provider.identity.id}'`,
    );
  }
  if (
    provider.snapshot.supported !== true ||
    provider.snapshot.capabilities.managedProfileRestore !== true
  ) {
    throw new ManagedSnapshotProfileRestoreError(
      `provider '${provider.identity.id}' does not support managed-profile restore`,
    );
  }
  if (!provider.workload.acceptsReceipt(sourceAuthority.receipt)) {
    throw new ManagedSnapshotProfileRestoreError(
      `provider '${provider.identity.id}' does not accept the snapshot workload receipt`,
    );
  }

  let targetAuthority: ManagedWorkloadAuthority | null;
  try {
    targetAuthority = readManagedWorkloadAuthority(target);
  } catch (error) {
    throw new ManagedSnapshotProfileRestoreError(
      `target '${target.name}' has invalid managed workload authority`,
      { cause: error },
    );
  }
  if (!targetAuthority) {
    throw new ManagedSnapshotProfileRestoreError(
      `target '${target.name}' is not the snapshot's managed workload`,
    );
  }
  if (target.name !== source.sandboxName || targetAuthority.agent !== sourceAuthority.agent) {
    throw new ManagedSnapshotProfileRestoreError(
      `target '${target.name}' requires a managed image or startup-profile rebind`,
    );
  }
  if (!provider.workload.acceptsReceipt(targetAuthority.receipt)) {
    throw new ManagedSnapshotProfileRestoreError(
      `provider '${provider.identity.id}' does not accept the target workload receipt`,
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    providerId: provider.identity.id,
    sourceSandboxName: source.sandboxName,
    targetSandboxName: target.name,
    authority: sourceAuthority,
    providerRestoreAuthority: {
      agent: targetAuthority.agent,
      profileFingerprint: fingerprintManagedStartupProfile(targetAuthority.profile),
    },
  });
}

/**
 * Managed cross-sandbox restore cannot reuse the legacy image-only create path:
 * its startup profile contains sandbox-scoped authority. Validate the source
 * first, then stop before deletion or creation until clone/rebind is available.
 */
export function rejectManagedSnapshotCloneUntilRebind(
  source: ManagedSnapshotProfileSource,
  targetSandboxName: string,
): void {
  const authority = readManagedSnapshotProfileAuthority(source);
  if (!authority) return;
  throw new ManagedSnapshotProfileRestoreError(
    `restoring '${source.sandboxName}' as '${targetSandboxName}' requires managed-profile clone rebind`,
  );
}
