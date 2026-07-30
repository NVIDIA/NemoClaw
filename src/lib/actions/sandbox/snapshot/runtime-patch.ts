// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ManagedStartupRuntimeRequirements,
  resolveManagedStartupRuntimeRequirements,
} from "../../../onboard/compute/managed-startup-runtime-requirements";
import {
  createSandboxCreateRuntimePatch,
  currentSandboxCreateRuntimePatchAdapters,
  type SandboxCreateRuntimeLifecycleContext,
  type SandboxCreateRuntimePatchRequest,
} from "../../../onboard/sandbox-create-runtime/registry";
import type { SandboxCreateRuntimePatch } from "../../../onboard/sandbox-create-runtime/types";
import type { SandboxEntry } from "../../../state/registry";

export interface ManagedSnapshotRuntimePatchContext {
  readonly destinationSandboxName: string;
  readonly sourceEntry: SandboxEntry;
}

export interface ManagedSnapshotRuntimePatchDependencies {
  readonly createRuntimePatch?: (
    request: SandboxCreateRuntimePatchRequest,
  ) => SandboxCreateRuntimePatch;
  readonly resolveRuntimeAuthority?: (
    driverName: string,
    context: ManagedSnapshotRuntimePatchContext,
  ) => unknown;
  readonly resolveRuntimeRequirements?: (
    driverName: string,
    context: ManagedSnapshotRuntimePatchContext,
    options: { readonly managedGatewayOwned: boolean },
  ) => ManagedStartupRuntimeRequirements;
}

export interface ManagedSnapshotRuntimePatchInput extends ManagedSnapshotRuntimePatchContext {
  readonly createDockerPatch?: (
    lifecycle: SandboxCreateRuntimeLifecycleContext,
  ) => SandboxCreateRuntimePatch;
  readonly lifecycle: Omit<
    SandboxCreateRuntimeLifecycleContext,
    "persistStartupCommand" | "requiredUlimits" | "sandboxGpuEnabled"
  >;
}

function snapshotRuntimeDriver(sourceEntry: SandboxEntry): string {
  const recorded = sourceEntry.openshellDriver?.trim();
  // Legacy VM records use the same Docker-compatible managed-startup patch
  // path as unrecorded and explicit Docker sandboxes.
  return !recorded || recorded === "vm" ? "docker" : recorded;
}

/**
 * Route managed snapshot clones through the shared runtime-patch registry.
 *
 * A native runtime may require lifecycle authority that snapshot.ts cannot
 * safely infer. Resolve those dependencies in the owning runtime composition
 * and inject the exact result here. Missing dependencies fail before sandbox
 * creation begins; Docker keeps its existing dependency-free selection path.
 */
export function createManagedSnapshotRuntimePatch(
  input: ManagedSnapshotRuntimePatchInput,
  dependencies: ManagedSnapshotRuntimePatchDependencies = {},
): SandboxCreateRuntimePatch {
  const driverName = snapshotRuntimeDriver(input.sourceEntry);
  const context = {
    destinationSandboxName: input.destinationSandboxName,
    sourceEntry: input.sourceEntry,
  } as const;
  const runtimeAuthority = dependencies.resolveRuntimeAuthority?.(driverName, context);
  const managedGatewayOwned = driverName !== "docker" && runtimeAuthority != null;
  const runtimeRequirements = dependencies.resolveRuntimeRequirements
    ? dependencies.resolveRuntimeRequirements(driverName, context, { managedGatewayOwned })
    : resolveManagedStartupRuntimeRequirements(
        typeof input.sourceEntry.agent === "string" ? { name: input.sourceEntry.agent } : null,
        driverName,
        { managedGatewayOwned },
      );

  const lifecycle: SandboxCreateRuntimeLifecycleContext = {
    ...input.lifecycle,
    ...runtimeRequirements,
    sandboxGpuEnabled: false,
  };
  const request: SandboxCreateRuntimePatchRequest = {
    driverName,
    lifecycle,
    runtimeAuthority,
  };
  if (dependencies.createRuntimePatch) return dependencies.createRuntimePatch(request);
  const dockerPatch = driverName === "docker" ? input.createDockerPatch?.(lifecycle) : undefined;
  return createSandboxCreateRuntimePatch(
    request,
    currentSandboxCreateRuntimePatchAdapters(dockerPatch),
  );
}

export function runAuthorizedManagedSnapshotDestinationDelete(
  runtimePatch: SandboxCreateRuntimePatch | null,
  deleteDestination: () => void,
): void {
  runtimePatch?.revalidateBeforeMutation();
  deleteDestination();
}
