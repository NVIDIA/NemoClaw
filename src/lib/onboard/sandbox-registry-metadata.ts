// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { DEFAULT_GATEWAY_NAME } from "../state/gateway-name";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { getSandboxAgentRegistryFields } from "./sandbox-agent";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

export interface SandboxRegistryMetadataDeps {
  isLinuxDockerDriverGatewayEnabled(): boolean;
  getInstalledOpenshellVersion(versionOutput?: string | null): string | null;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface SandboxRegistryMetadataHelpers {
  getSandboxRuntimeRegistryFields(
    config: SandboxGpuConfig,
    gatewayName?: string,
  ): Pick<
    SandboxEntry,
    | "gpuEnabled"
    | "hostGpuDetected"
    | "sandboxGpuEnabled"
    | "sandboxGpuMode"
    | "sandboxGpuDevice"
    | "openshellDriver"
    | "openshellVersion"
    | "gatewayName"
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
  ): void;
}

export function createSandboxRegistryMetadataHelpers(
  deps: SandboxRegistryMetadataDeps,
): SandboxRegistryMetadataHelpers {
  function getSandboxRuntimeRegistryFields(
    config: SandboxGpuConfig,
    gatewayName?: string,
  ): Pick<
    SandboxEntry,
    | "gpuEnabled"
    | "hostGpuDetected"
    | "sandboxGpuEnabled"
    | "sandboxGpuMode"
    | "sandboxGpuDevice"
    | "openshellDriver"
    | "openshellVersion"
    | "gatewayName"
  > {
    // OpenShell's Docker-driver gateway always starts with OPENSHELL_DRIVERS=docker,
    // including on macOS arm64 (#3454). Recording "vm" for darwin here makes later
    // setup misclassify the sandbox and run VM-only DNS monkeypatch / warning paths
    // (#3728).
    return {
      gpuEnabled: config.sandboxGpuEnabled,
      hostGpuDetected: config.hostGpuDetected,
      sandboxGpuEnabled: config.sandboxGpuEnabled,
      sandboxGpuMode: config.mode,
      sandboxGpuDevice: config.sandboxGpuDevice,
      openshellDriver: deps.isLinuxDockerDriverGatewayEnabled() ? "docker" : "kubernetes",
      openshellVersion: deps.getInstalledOpenshellVersion(
        deps.runCaptureOpenshell(["--version"], { ignoreError: true }),
      ),
      ...(gatewayName ? { gatewayName } : {}),
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
  ): void {
    const existingEntry = registry.getSandbox(sandboxName);
    const agentVersionKnown = existingEntry?.agentVersion !== null;
    const selectionUpdates = selectionVerified ? { model, provider } : {};
    // Migrate legacy reused entries that predate per-sandbox gateway tracking
    // by recording the singleton gateway name on first reuse. When existing
    // entries already carry a binding, preserve it untouched.
    const gatewayMigration =
      existingEntry && existingEntry.gatewayName === undefined
        ? { gatewayName: DEFAULT_GATEWAY_NAME }
        : {};
    registry.updateSandbox(sandboxName, {
      ...selectionUpdates,
      dashboardPort,
      ...getSandboxAgentRegistryFields(agent, agentVersionKnown),
      ...(sandboxGpuConfig ? getSandboxRuntimeRegistryFields(sandboxGpuConfig) : {}),
      ...gatewayMigration,
    });
    registry.setDefault(sandboxName);
  }

  return { getSandboxRuntimeRegistryFields, hasSandboxGpuDrift, updateReusedSandboxMetadata };
}
