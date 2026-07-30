// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import { MANAGED_STARTUP_AGENTS } from "../managed-startup/profile";

const DCODE_AGENT = "langchain-deepagents-code";
const MANAGED_IMAGE_AGENTS = new Set<string>(MANAGED_STARTUP_AGENTS);

export interface SandboxRuntimeUlimit {
  readonly name: string;
  readonly soft: number;
  readonly hard: number;
}

export interface ManagedStartupRuntimeRequirements {
  readonly persistStartupCommand: boolean;
  readonly requiredUlimits: readonly SandboxRuntimeUlimit[] | null;
}

export interface ManagedStartupRuntimeRequirementsContext {
  /**
   * Whether NemoClaw owns the selected gateway lifecycle and may therefore
   * recreate its runtime container to persist command/resource requirements.
   */
  readonly managedGatewayOwned: boolean;
}

export interface ManagedStartupRuntimeRequirementsAdapter {
  readonly driverName: string;
  resolve(
    agentName: string | null,
    context: ManagedStartupRuntimeRequirementsContext,
  ): ManagedStartupRuntimeRequirements;
}

export type ManagedStartupRuntimeRequirementsAdapterRegistry = Readonly<
  Record<string, ManagedStartupRuntimeRequirementsAdapter>
>;

// DCode's image-owned startup contract fails closed unless the supervisor and
// every child inherit these exact limits. Keep the requirement independent of
// the container engine that materializes it.
export const DCODE_MANAGED_RUNTIME_ULIMITS: readonly SandboxRuntimeUlimit[] = [
  { name: "nproc", soft: 512, hard: 512 },
  { name: "nofile", soft: 65_536, hard: 65_536 },
];

const NONE: ManagedStartupRuntimeRequirements = {
  persistStartupCommand: false,
  requiredUlimits: null,
};

export const CURRENT_MANAGED_STARTUP_RUNTIME_REQUIREMENTS_ADAPTERS = {
  docker: {
    driverName: "docker",
    resolve(agentName, context) {
      // Preserve the established ownership boundary: OpenShell-managed Docker
      // gateways are not ours to recreate solely for startup persistence or
      // DCode resource limits.
      if (!context.managedGatewayOwned) return NONE;
      return {
        // The existing Docker driver preserves OpenClaw's command, while
        // Hermes and DCode require the established resource-only recreation.
        persistStartupCommand: agentName === "hermes" || agentName === DCODE_AGENT,
        requiredUlimits: agentName === DCODE_AGENT ? DCODE_MANAGED_RUNTIME_ULIMITS : null,
      };
    },
  },
  kubernetes: {
    driverName: "kubernetes",
    resolve() {
      return NONE;
    },
  },
  podman: {
    driverName: "podman",
    resolve(agentName) {
      if (!agentName || !MANAGED_IMAGE_AGENTS.has(agentName)) return NONE;
      // The native Podman driver intentionally starts `sleep infinity`; every
      // managed image therefore needs the image-owned startup hold persisted
      // into the final container configuration.
      return {
        persistStartupCommand: true,
        requiredUlimits: agentName === DCODE_AGENT ? DCODE_MANAGED_RUNTIME_ULIMITS : null,
      };
    },
  },
} as const satisfies ManagedStartupRuntimeRequirementsAdapterRegistry;

export function resolveManagedStartupRuntimeRequirements(
  agent: Pick<AgentDefinition, "name"> | null | undefined,
  driverName: string,
  context: ManagedStartupRuntimeRequirementsContext,
  adapters: ManagedStartupRuntimeRequirementsAdapterRegistry = CURRENT_MANAGED_STARTUP_RUNTIME_REQUIREMENTS_ADAPTERS,
): ManagedStartupRuntimeRequirements {
  const adapter = Object.hasOwn(adapters, driverName) ? adapters[driverName] : undefined;
  if (!adapter || adapter.driverName !== driverName) {
    throw new Error(
      `OpenShell compute driver '${driverName}' has no managed-startup requirements adapter.`,
    );
  }
  const resolved = adapter.resolve(agent?.name ?? null, context);
  return {
    persistStartupCommand: resolved.persistStartupCommand,
    requiredUlimits: resolved.requiredUlimits
      ? resolved.requiredUlimits.map((limit) => ({ ...limit }))
      : null,
  };
}
