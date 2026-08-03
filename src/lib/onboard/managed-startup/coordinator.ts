// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CommittedManagedStartupApplication,
  commitManagedStartupApplication,
  type PreparedManagedStartupApplication,
  type PrepareManagedStartupApplicationInput,
  prepareManagedStartupApplication,
} from "./application";
import {
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
} from "./profile";

export interface ManagedStartupAdapterContext {
  readonly agent: ManagedStartupAgent;
  readonly profile: ManagedStartupProfile;
  readonly fingerprint: string;
  readonly generationDirectory: string;
  readonly profilePath: string;
  readonly corporateCaPath: string | null;
}

export interface ManagedStartupAgentAdapter {
  readonly agent: ManagedStartupAgent;
  readonly apply: (context: ManagedStartupAdapterContext) => void | Promise<void>;
}

export interface ManagedStartupCoordinatorDependencies {
  readonly prepareApplication: (
    input: PrepareManagedStartupApplicationInput,
  ) => PreparedManagedStartupApplication | Promise<PreparedManagedStartupApplication>;
  readonly commitApplication: (
    prepared: PreparedManagedStartupApplication,
  ) => CommittedManagedStartupApplication | Promise<CommittedManagedStartupApplication>;
}

export interface ManagedStartupCoordinationResult {
  readonly adapterApplied: boolean;
  readonly application: CommittedManagedStartupApplication;
}

type AdapterRegistry = Readonly<Record<ManagedStartupAgent, ManagedStartupAgentAdapter>>;

const SHIPPED_AGENT_SET = new Set<string>(MANAGED_STARTUP_AGENTS);

const DEFAULT_DEPENDENCIES: ManagedStartupCoordinatorDependencies = {
  prepareApplication: (input) => prepareManagedStartupApplication(input),
  commitApplication: (prepared) => commitManagedStartupApplication(prepared),
};

export class ManagedStartupCoordinatorError extends Error {
  constructor(message: string) {
    super(`Managed startup coordination failed: ${message}`);
    this.name = "ManagedStartupCoordinatorError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupCoordinatorError(message);
}

function createAdapterRegistry(adapters: readonly ManagedStartupAgentAdapter[]): AdapterRegistry {
  const byAgent = new Map<ManagedStartupAgent, ManagedStartupAgentAdapter>();
  for (const adapter of adapters) {
    if (
      typeof adapter !== "object" ||
      adapter === null ||
      !SHIPPED_AGENT_SET.has(adapter.agent) ||
      typeof adapter.apply !== "function"
    ) {
      fail("every adapter must identify one shipped agent and provide an apply function");
    }
    if (byAgent.has(adapter.agent)) {
      fail(`duplicate adapter registered for ${adapter.agent}`);
    }
    byAgent.set(adapter.agent, adapter);
  }

  const missing = MANAGED_STARTUP_AGENTS.filter((agent) => !byAgent.has(agent));
  if (missing.length > 0) {
    fail(`missing adapter for ${missing.join(", ")}`);
  }
  if (byAgent.size !== MANAGED_STARTUP_AGENTS.length) {
    fail("adapter registry must contain exactly the shipped agents");
  }

  return Object.freeze(
    Object.fromEntries(
      MANAGED_STARTUP_AGENTS.map((agent) => {
        const adapter = byAgent.get(agent);
        if (!adapter) fail(`missing adapter for ${agent}`);
        return [agent, adapter];
      }),
    ),
  ) as AdapterRegistry;
}

function requirePreparedIdentity(
  prepared: PreparedManagedStartupApplication,
  requestedAgent: ManagedStartupAgent,
): void {
  if (prepared.expectedAgent !== requestedAgent || prepared.profile.agent !== requestedAgent) {
    fail(`prepared profile targets ${prepared.profile.agent}, expected ${requestedAgent}`);
  }
}

function adapterContext(prepared: PreparedManagedStartupApplication): ManagedStartupAdapterContext {
  return Object.freeze({
    agent: prepared.profile.agent,
    profile: prepared.profile,
    fingerprint: prepared.fingerprint,
    generationDirectory: prepared.generationDirectory,
    profilePath: prepared.profilePath,
    corporateCaPath: prepared.corporateCaPath,
  });
}

/**
 * Coordinate one managed startup without depending on a host container driver.
 *
 * A complete, duplicate-free adapter registry is required before application
 * state is prepared. New pending profiles dispatch exactly their matching
 * adapter and commit only after it succeeds. An already committed profile is
 * revalidated through commit without reapplying mutable agent configuration.
 */
export async function coordinateManagedStartupApplication(
  input: PrepareManagedStartupApplicationInput,
  adapters: readonly ManagedStartupAgentAdapter[],
  dependencies: ManagedStartupCoordinatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<ManagedStartupCoordinationResult> {
  const registry = createAdapterRegistry(adapters);
  const prepared = await dependencies.prepareApplication(input);
  requirePreparedIdentity(prepared, input.expectedAgent);

  if (prepared.status === "already-committed") {
    return {
      adapterApplied: false,
      application: await dependencies.commitApplication(prepared),
    };
  }

  const adapter = registry[prepared.profile.agent];
  if (adapter.agent !== prepared.profile.agent) {
    fail(`adapter registry cross-dispatch detected for ${prepared.profile.agent}`);
  }
  await adapter.apply(adapterContext(prepared));
  return {
    adapterApplied: true,
    application: await dependencies.commitApplication(prepared),
  };
}
