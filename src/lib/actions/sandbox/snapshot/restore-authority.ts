// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import {
  prepareManagedSnapshotProfileRestore,
  readManagedSnapshotProfileAuthority,
} from "./managed-profile";
import {
  confirmSandboxRuntimeRestore,
  type PreparedSandboxRuntimeRestore,
  prepareSandboxRuntimeRestore,
} from "./provider-lifecycle";

interface ManagedRestoreAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly requireProvider: (sandbox: SandboxEntry) => RuntimeProviderBundle;
  readonly captureContentAuthority: typeof sandboxState.captureSnapshotRestoreAuthority;
  readonly restore: typeof sandboxState.restoreRecreatedSandboxState;
}

const defaultDependencies: Omit<ManagedRestoreAuthorityDependencies, "getSandbox"> = {
  requireProvider: (sandbox) =>
    requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES),
  captureContentAuthority: (...args) => sandboxState.captureSnapshotRestoreAuthority(...args),
  restore: (...args) => sandboxState.restoreRecreatedSandboxState(...args),
};

function failure(error: unknown): sandboxState.RestoreResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    restoredDirs: [],
    failedDirs: ["manifest"],
    restoredFiles: [],
    failedFiles: [],
    error: `Cannot restore managed snapshot authority: ${detail}.`,
  };
}

/**
 * Restore a rebuild backup through the same provider and content authority
 * boundary as an explicit snapshot restore. Legacy/custom-image manifests
 * retain their existing state-only path.
 */
export function restoreRecreatedSandboxStateWithManagedAuthority(
  sandboxName: string,
  manifest: sandboxState.RebuildManifest,
  options: sandboxState.RecreatedSandboxRestoreOptions,
  overrides: Pick<ManagedRestoreAuthorityDependencies, "getSandbox"> &
    Partial<Omit<ManagedRestoreAuthorityDependencies, "getSandbox">>,
): sandboxState.RestoreResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  let snapshotProfile;
  try {
    snapshotProfile = readManagedSnapshotProfileAuthority({
      sandboxName: manifest.sandboxName,
      agentType: manifest.agentType,
      workload: manifest.workload,
    });
  } catch (error) {
    return failure(error);
  }
  if (!snapshotProfile) {
    return dependencies.restore(sandboxName, manifest.backupPath, options);
  }
  if (!manifest.runtimeSnapshot) {
    return failure("managed snapshot is missing provider runtime authority");
  }

  let prepared: PreparedSandboxRuntimeRestore;
  let providerId: string;
  let contentAuthority: sandboxState.SnapshotRestoreAuthority;
  try {
    const target = dependencies.getSandbox(sandboxName);
    if (!target) throw new Error(`target '${sandboxName}' is not registered`);
    const provider = dependencies.requireProvider(target);
    providerId = provider.identity.id;
    const profileRestore = prepareManagedSnapshotProfileRestore(
      {
        sandboxName: manifest.sandboxName,
        agentType: manifest.agentType,
        workload: manifest.workload,
      },
      target,
      provider,
    );
    if (!profileRestore) throw new Error("managed profile restore authority is missing");
    const captured = dependencies.captureContentAuthority(manifest.backupPath, manifest);
    if (!captured) throw new Error("selected snapshot content changed during restore preflight");
    contentAuthority = captured;
    prepared = prepareSandboxRuntimeRestore(
      provider,
      target,
      manifest.runtimeSnapshot,
      profileRestore.providerRestoreAuthority,
    );
  } catch (error) {
    return failure(error);
  }

  const restore = dependencies.restore(sandboxName, manifest.backupPath, {
    ...options,
    authority: contentAuthority,
    validateBeforeMutation: () => {
      const current = dependencies.getSandbox(sandboxName);
      if (!current) throw new Error(`target '${sandboxName}' is no longer registered`);
      const provider = dependencies.requireProvider(current);
      if (provider.identity.id !== providerId) {
        throw new Error(`target '${sandboxName}' runtime provider changed before restore`);
      }
      const profileRestore = prepareManagedSnapshotProfileRestore(
        {
          sandboxName: manifest.sandboxName,
          agentType: manifest.agentType,
          workload: manifest.workload,
        },
        current,
        provider,
      );
      if (!profileRestore) throw new Error("managed profile restore authority is missing");
      prepared = prepareSandboxRuntimeRestore(
        provider,
        current,
        prepared.source,
        profileRestore.providerRestoreAuthority,
      );
    },
  });
  if (!restore.success) return restore;

  try {
    const current = dependencies.getSandbox(sandboxName);
    if (!current) throw new Error(`target '${sandboxName}' is no longer registered`);
    const provider = dependencies.requireProvider(current);
    if (provider.identity.id !== providerId) {
      throw new Error(`target '${sandboxName}' runtime provider changed during restore`);
    }
    confirmSandboxRuntimeRestore(provider, current, prepared);
    return restore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...restore,
      success: false,
      error:
        `State was restored, but managed runtime proof failed: ${detail}. ` +
        `Retry this exact snapshot after the runtime stabilizes.`,
    };
  }
}
