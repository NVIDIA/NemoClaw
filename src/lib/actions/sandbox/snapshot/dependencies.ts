// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../../state/registry/types";

export {
  ManagedSnapshotProfileRestoreError,
  prepareManagedSnapshotProfileRestore,
  readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind,
} from "./managed-profile";
export type {
  PreparedSandboxRuntimeRestore,
  ValidatedSandboxRuntimeRestore,
} from "./provider-lifecycle";
export {
  captureSandboxRuntimeSnapshot,
  confirmSandboxRuntimeRestore,
  prepareSandboxRuntimeRestore,
  SandboxSnapshotProviderError,
} from "./provider-lifecycle";
export { backupSandboxStateWithManagedAuthority } from "./backup-authority";

/**
 * Resolve the one already-registered provider bundle for a durable sandbox.
 * Snapshot actions never maintain a second provider map or infer a container
 * engine from host state.
 */
export function requireCurrentSnapshotRuntimeProvider(
  sandbox: SandboxEntry,
): RuntimeProviderBundle {
  return requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES);
}
