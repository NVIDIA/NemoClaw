// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Driver-neutral lifecycle used while OpenShell creates a sandbox.
 *
 * Docker, Podman, and future driver adapters implement this transaction
 * boundary. Runtime-specific capabilities (including Docker GPU patching) are
 * composed by their owning adapter/caller instead of leaking into this
 * lifecycle contract.
 */
export interface SandboxCreateRuntimePatch {
  revalidateBeforeMutation(): void;
  maybeApplyDuringCreate(): void;
  createFailureMessage(): string | null;
  exitOnPatchError(): void;
  rollbackManagedStartupAfterCreateFailure(): void;
  ensureApplied(): void;
  waitForSupervisorReconnectIfNeeded(): void;
  commitAfterReady(): void;
}
