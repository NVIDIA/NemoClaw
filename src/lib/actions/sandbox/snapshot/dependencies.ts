// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import { assertHermesPortableCommandUnavailable } from "../../../onboard/experimental/portable-agent-lifecycle";
export { isSandboxPolicyCredentialFree } from "../../../policy/sandbox-policy-validation";
import type { SandboxEntry } from "../../../state/registry/types";

export {
  confirmHostLocalInferenceAuthority,
  type PreparedHostLocalInferenceAuthority,
  prepareHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  retirePreparedHostLocalInferenceAuthority,
} from "../../../onboard/runtime-provider/host-local-inference-lifecycle";
export type {
  ManagedWorkloadCloneSnapshot,
  PreparedManagedWorkloadCloneHandoff,
  PrepareManagedWorkloadCloneHandoffInput,
} from "../../../onboard/workload/clone";
export { backupSandboxStateWithManagedAuthority } from "./backup-authority";
export { createSnapshotCloneLifecycle, fingerprintSandboxLiveIdentity } from "./clone-lifecycle";
export { restoreDeepAgentsManagedMcpProjection } from "../mcp-bridge-adapter-deepagents-registration";
export { getMcpProviderInspectionRuntimeSelection } from "../mcp-bridge-provider-inspection";
export type {
  ManagedCloneProviderBinding,
  ManagedCloneProviderCleanupResult,
  ManagedCloneProviderCommandResult,
  ManagedCloneProviderOwnershipReceipt,
  ManagedCloneProviderRunner,
  ManagedCloneProviderTransactionReceipt,
  PreparedManagedCloneProvider,
  PreparedManagedCloneProviderTransaction,
} from "./managed-clone-providers";
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
export type { RuntimeProviderBundle };

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

export function assertSandboxSnapshotCommandAvailable(
  sandboxName: string,
  commandId: "sandbox:snapshot:create" | "sandbox:snapshot:list" | "sandbox:snapshot:restore",
): void {
  assertHermesPortableCommandUnavailable(sandboxName, commandId);
}
