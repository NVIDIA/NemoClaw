// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { HERMES_PORTABLE_OPENSHELL_VERSION } from "../adapters/openshell/resolve-shared";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { getSandboxAgentRegistryFields } from "./sandbox-agent";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

export interface SandboxRegistryMetadataDeps {
  getCurrentRuntimeProviderId(): string;
  getInstalledOpenshellVersion(versionOutput?: string | null): string | null;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface SandboxRegistryMetadataHelpers {
  getSandboxRuntimeRegistryFields(
    config: SandboxGpuConfig,
  ): Pick<
    SandboxEntry,
    | "gpuEnabled"
    | "hostGpuDetected"
    | "sandboxGpuEnabled"
    | "sandboxGpuMode"
    | "sandboxGpuDevice"
    | "sandboxGpuProof"
    | "openshellDriver"
    | "openshellVersion"
  >;
  hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean;
  updateReusedSandboxMetadata(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
    model: string,
    provider: string,
    dashboardPort: number,
    selectionVerified?: boolean,
    sandboxGpuConfig?: SandboxGpuConfig | null,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): void;
}

/** Build schema-5 runtime fields without ambient driver or OpenShell discovery. */
export function getHermesPortableSandboxRuntimeRegistryFields(
  config: SandboxGpuConfig,
  openshellVersion: typeof HERMES_PORTABLE_OPENSHELL_VERSION,
): ReturnType<SandboxRegistryMetadataHelpers["getSandboxRuntimeRegistryFields"]> {
  return {
    gpuEnabled: config.sandboxGpuEnabled,
    hostGpuDetected: config.hostGpuDetected,
    sandboxGpuEnabled: config.sandboxGpuEnabled,
    sandboxGpuMode: config.mode,
    sandboxGpuDevice: config.sandboxGpuDevice,
    ...(config.sandboxGpuProof ? { sandboxGpuProof: config.sandboxGpuProof } : {}),
    openshellDriver: "docker",
    openshellVersion,
  };
}

export function createSandboxRegistryMetadataHelpers(
  deps: SandboxRegistryMetadataDeps,
): SandboxRegistryMetadataHelpers {
  function getSandboxRuntimeRegistryFields(
    config: SandboxGpuConfig,
  ): Pick<
    SandboxEntry,
    | "gpuEnabled"
    | "hostGpuDetected"
    | "sandboxGpuEnabled"
    | "sandboxGpuMode"
    | "sandboxGpuDevice"
    | "sandboxGpuProof"
    | "openshellDriver"
    | "openshellVersion"
  > {
    return {
      gpuEnabled: config.sandboxGpuEnabled,
      hostGpuDetected: config.hostGpuDetected,
      sandboxGpuEnabled: config.sandboxGpuEnabled,
      sandboxGpuMode: config.mode,
      sandboxGpuDevice: config.sandboxGpuDevice,
      // Only persist a proof when this run produced one; omit on reuse/update
      // paths so a prior proof result is preserved rather than nulled out.
      ...(config.sandboxGpuProof ? { sandboxGpuProof: config.sandboxGpuProof } : {}),
      // Persist the selected managed provider identity. The provider may use
      // compatibility compute plumbing internally without becoming Docker.
      openshellDriver: deps.getCurrentRuntimeProviderId(),
      openshellVersion: deps.getInstalledOpenshellVersion(
        deps.runCaptureOpenshell(["--version"], { ignoreError: true }),
      ),
    };
  }

  function hasSandboxGpuDrift(sandboxName: string, config: SandboxGpuConfig): boolean {
    const existingEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
    if (!existingEntry) return false;
    return (
      (existingEntry.sandboxGpuEnabled === true) !== config.sandboxGpuEnabled ||
      (existingEntry.sandboxGpuMode || "auto") !== config.mode ||
      (existingEntry.sandboxGpuDevice || null) !== config.sandboxGpuDevice
    );
  }

  function updateReusedSandboxMetadata(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
    model: string,
    provider: string,
    dashboardPort: number,
    selectionVerified = true,
    sandboxGpuConfig: SandboxGpuConfig | null = null,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): void {
    const existingEntry = registry.getSandbox(sandboxName);
    const agentFields = getSandboxAgentRegistryFields(agent, false);
    const selectionUpdates = selectionVerified ? { model, provider } : {};
    revalidateSandboxIdentity?.(`record reused sandbox metadata for '${sandboxName}'`);
    registry.updateSandbox(sandboxName, {
      ...selectionUpdates,
      dashboardPort,
      agent: existingEntry?.agent !== undefined ? existingEntry.agent : agentFields.agent,
      agentVersion: existingEntry?.agentVersion ?? null,
      ...(sandboxGpuConfig ? getSandboxRuntimeRegistryFields(sandboxGpuConfig) : {}),
    });
    revalidateSandboxIdentity?.(`make reused sandbox '${sandboxName}' the default`);
    registry.setDefault(sandboxName);
  }

  return { getSandboxRuntimeRegistryFields, hasSandboxGpuDrift, updateReusedSandboxMetadata };
}
