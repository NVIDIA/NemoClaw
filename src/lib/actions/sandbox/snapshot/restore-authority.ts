// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { isDeepStrictEqual } from "node:util";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import {
  confirmHostLocalInferenceAuthority,
  type PreparedHostLocalInferenceAuthority,
  prepareHostLocalInferenceAuthority,
} from "../../../onboard/runtime-provider/host-local-inference-lifecycle";
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

interface ProviderRestoreAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly requireProvider: (sandbox: SandboxEntry) => RuntimeProviderBundle;
  readonly captureContentAuthority: typeof sandboxState.captureSnapshotRestoreAuthority;
  readonly prepareHostLocalInference: typeof prepareHostLocalInferenceAuthority;
  readonly confirmHostLocalInference: typeof confirmHostLocalInferenceAuthority;
  readonly restore: typeof sandboxState.restoreRecreatedSandboxState;
}

const defaultDependencies: Omit<ProviderRestoreAuthorityDependencies, "getSandbox"> = {
  requireProvider: (sandbox) =>
    requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES),
  captureContentAuthority: (...args) => sandboxState.captureSnapshotRestoreAuthority(...args),
  prepareHostLocalInference: prepareHostLocalInferenceAuthority,
  confirmHostLocalInference: confirmHostLocalInferenceAuthority,
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
    error: `Cannot restore provider snapshot authority: ${detail}.`,
  };
}

/**
 * Restore a rebuild backup through its provider runtime and content authority.
 * Legacy/custom-image manifests without provider-backed state retain the
 * existing state-only path.
 */
export function restoreRecreatedSandboxStateWithManagedAuthority(
  sandboxName: string,
  manifest: sandboxState.RebuildManifest,
  options: sandboxState.RecreatedSandboxRestoreOptions,
  overrides: Pick<ProviderRestoreAuthorityDependencies, "getSandbox"> &
    Partial<Omit<ProviderRestoreAuthorityDependencies, "getSandbox">>,
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
  const hostLocalInferenceReceipt = manifest.hostLocalInferenceReceipt;
  if (!snapshotProfile && typeof hostLocalInferenceReceipt !== "string") {
    return dependencies.restore(sandboxName, manifest.backupPath, options);
  }
  if (snapshotProfile && !manifest.runtimeSnapshot) {
    return failure("managed snapshot is missing provider runtime authority");
  }

  let preparedRuntime: PreparedSandboxRuntimeRestore | null = null;
  let preparedHostLocal: PreparedHostLocalInferenceAuthority | null = null;
  let providerId: string;
  let contentAuthority: sandboxState.SnapshotRestoreAuthority;
  try {
    const target = dependencies.getSandbox(sandboxName);
    if (!target) throw new Error(`target '${sandboxName}' is not registered`);
    const provider = dependencies.requireProvider(target);
    providerId = provider.identity.id;
    if (snapshotProfile) {
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
      preparedRuntime = prepareSandboxRuntimeRestore(
        provider,
        target,
        manifest.runtimeSnapshot!,
        profileRestore.providerRestoreAuthority,
      );
    }
    if (typeof hostLocalInferenceReceipt === "string") {
      if (
        !isDeepStrictEqual(
          target.hostLocalInferenceProvenance,
          manifest.hostLocalInferenceProvenance,
        )
      ) {
        throw new Error("snapshot inference provenance differs from the target lifecycle");
      }
      preparedHostLocal = dependencies.prepareHostLocalInference(
        provider,
        target,
        hostLocalInferenceReceipt,
      );
      if (!preparedHostLocal) {
        throw new Error("snapshot inference receipt has no common lifecycle authority");
      }
    }
    const captured = dependencies.captureContentAuthority(manifest.backupPath, manifest);
    if (!captured) throw new Error("selected snapshot content changed during restore preflight");
    contentAuthority = captured;
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
      if (snapshotProfile) {
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
        if (!preparedRuntime) throw new Error("managed runtime restore authority is missing");
        preparedRuntime = prepareSandboxRuntimeRestore(
          provider,
          current,
          preparedRuntime.source,
          profileRestore.providerRestoreAuthority,
        );
      }
      if (typeof hostLocalInferenceReceipt === "string") {
        if (!preparedHostLocal) {
          throw new Error("host-local inference restore authority is missing");
        }
        if (
          !isDeepStrictEqual(
            current.hostLocalInferenceProvenance,
            manifest.hostLocalInferenceProvenance,
          )
        ) {
          throw new Error("snapshot inference provenance changed before restore");
        }
        dependencies.confirmHostLocalInference(provider, current, preparedHostLocal);
      }
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
    if (preparedRuntime) confirmSandboxRuntimeRestore(provider, current, preparedRuntime);
    if (preparedHostLocal) {
      dependencies.confirmHostLocalInference(provider, current, preparedHostLocal);
    }
    return restore;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...restore,
      success: false,
      error:
        `State was restored, but provider runtime proof failed: ${detail}. ` +
        `Retry this exact snapshot after the runtime stabilizes.`,
    };
  }
}
