// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  assertDeepAgentsMcpMutationRuntimeCapability,
  inspectDeepAgentsAdapterRegistration,
  registerDeepAgentsAdapter,
  unregisterDeepAgentsAdapter,
} from "./mcp-bridge-adapter-deepagents";
import {
  assertHermesMcpMutationRuntimeCapability,
  inspectHermesAdapterRegistration,
  registerHermesAdapter,
  unregisterHermesAdapter,
} from "./mcp-bridge-adapter-hermes";
import type {
  AdapterMutationOptions,
  AdapterRegistrationInspection,
  AdapterRemovalOutcome,
} from "./mcp-bridge-adapter-inspection";
import {
  inspectOpenClawAdapterRegistration,
  registerOpenClawAdapter,
  unregisterOpenClawAdapter,
} from "./mcp-bridge-adapter-openclaw";
import {
  mcpAdapterCredentialRevisionUnavailableError,
  mcpAdapterCredentialRevisionUnstableError,
  type McpAttachedCredentialRevision,
  observeMcpCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import { type McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { waitForMcpBridgeConditionAsync } from "./mcp-bridge/timing";

const STABLE_CREDENTIAL_REVISION_OBSERVATIONS = 3;
const MAX_CREDENTIAL_REVISION_REGISTRATIONS = 2;

export {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";
export {
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
} from "./mcp-bridge-adapter-hermes";
export {
  type AdapterRegistrationInspection,
  parseAdapterRegistrationInspection,
} from "./mcp-bridge-adapter-inspection";
export {
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  MCPORTER_VERSION,
} from "./mcp-bridge-adapter-openclaw";
export {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEEPAGENTS_MCP_CONFIG_PATH,
  mcporterHeadersMatchExpected,
  openClawMcporterRoot,
} from "./mcp-bridge-adapter-status";

export async function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<AdapterRegistrationInspection> {
  switch (adapter) {
    case "mcporter":
      return await inspectOpenClawAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "hermes-config":
      return await inspectHermesAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "deepagents-config":
      return await inspectDeepAgentsAdapterRegistration(sandboxName, entry, runtimeSelection);
  }
}

export async function assertAgentMcpMutationRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  switch (adapter) {
    case "deepagents-config":
      await assertDeepAgentsMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "hermes-config":
      assertHermesMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "mcporter":
      return;
  }
}

/**
 * Validate the runtime needed to scrub an existing adapter definition.
 * Hermes teardown still uses its managed transaction helper and therefore
 * requires the full helper/lifecycle probe. Deep Agents teardown executes the
 * ownership-checked config scrub directly and must remain available to images
 * that predate the new launcher marker.
 */
export async function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (adapter === "hermes-config") {
    await assertAgentMcpMutationRuntimeCapability(sandboxName, adapter, runtimeSelection);
  }
}

export async function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    credentialRevision?: McpAttachedCredentialRevision;
  } = {},
): Promise<void> {
  switch (adapter) {
    case "mcporter":
      await registerOpenClawAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "hermes-config":
      await registerHermesAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "deepagents-config":
      await registerDeepAgentsAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.teardownRollback === true,
        options.credentialRevision,
      );
      return;
  }
}

/** Register one adapter and converge it on the credential revision exposed by fresh execs. */
export async function registerAgentAdapterAtCurrentCredentialRevision(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string>,
  initialCredentialRevision: McpAttachedCredentialRevision,
  options: { replaceExisting?: boolean; teardownRollback?: boolean } = {},
): Promise<McpAttachedCredentialRevision> {
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  let credentialRevision = initialCredentialRevision;
  let replaceExisting = options.replaceExisting === true;
  for (
    let registration = 1;
    registration <= MAX_CREDENTIAL_REVISION_REGISTRATIONS;
    registration += 1
  ) {
    await registerAgentAdapter(sandboxName, adapter, entry, runtimeSelection, envValues, {
      replaceExisting,
      teardownRollback: options.teardownRollback === true,
      credentialRevision,
    });
    let candidateRevision: McpAttachedCredentialRevision | undefined;
    let stableObservations = 0;
    let observedRevision: McpAttachedCredentialRevision | undefined;
    const stable = await waitForMcpBridgeConditionAsync(
      async () => {
        const observation = await observeMcpCredentialRevision(
          sandboxName,
          entry,
          runtimeSelection,
        );
        if (observation === "absent" || observation === "canonical") {
          throw mcpAdapterCredentialRevisionUnavailableError(entry.server);
        }
        if (candidateRevision !== observation) {
          candidateRevision = observation;
          stableObservations = 1;
          return false;
        }
        stableObservations += 1;
        if (stableObservations < STABLE_CREDENTIAL_REVISION_OBSERVATIONS) {
          return false;
        }
        observedRevision = observation;
        return true;
      },
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
      1_000,
    );
    if (!stable || observedRevision === undefined) {
      throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    }
    if (observedRevision === credentialRevision) {
      return credentialRevision;
    }
    if (registration === MAX_CREDENTIAL_REVISION_REGISTRATIONS) {
      throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    }
    credentialRevision = observedRevision;
    replaceExisting = true;
  }
  throw mcpAdapterCredentialRevisionUnstableError(entry.server);
}

export async function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): Promise<AdapterRemovalOutcome> {
  switch (adapter) {
    case "mcporter":
      await unregisterOpenClawAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "deepagents-config":
      return await unregisterDeepAgentsAdapter(sandboxName, entry, runtimeSelection, options);
  }
}
