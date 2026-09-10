// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpOperationTarget } from "./mcp-bridge-state";
import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
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
  reloadOpenClawGatewayAfterMcpMutation as reloadOpenClawGateway,
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
  buildOpenClawMcpRegisterCommand,
  buildOpenClawMcpRemoveCommand,
  MCPORTER_VERSION,
} from "./mcp-bridge-adapter-openclaw";
export {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcpInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEEPAGENTS_MCP_CONFIG_PATH,
  openClawHeadersMatchExpected,
  openClawConfigDir,
} from "./mcp-bridge-adapter-status";

export function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): AdapterRegistrationInspection {
  switch (adapter) {
    case "openclaw-config":
      return inspectOpenClawAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "hermes-config":
      return inspectHermesAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "deepagents-config":
      return inspectDeepAgentsAdapterRegistration(sandboxName, entry, runtimeSelection);
  }
}

export function assertAgentMcpMutationRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  switch (adapter) {
    case "deepagents-config":
      assertDeepAgentsMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "hermes-config":
      assertHermesMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "openclaw-config":
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
export function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  if (adapter === "hermes-config") {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter, runtimeSelection);
  }
}

export async function reloadOpenClawGatewayAfterMcpMutation(
  sandboxName: string,
  adapters: readonly AgentMcpAdapter[],
  operationTarget?: McpOperationTarget,
): Promise<void> {
  if (adapters.includes("openclaw-config")) {
    if (operationTarget) await reloadOpenClawGateway(sandboxName, operationTarget);
    else await reloadOpenClawGateway(sandboxName);
  }
}

function assertAdapterOperationTarget(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  target?: McpOperationTarget,
): void {
  if (!target?.liveIdentity) return;
  if (
    target.sandbox.name !== sandboxName ||
    target.runtimeSelection.gatewayName !== runtimeSelection.gatewayName ||
    target.runtimeSelection.workspace !== runtimeSelection.workspace ||
    target.runtimeSelection.localTlsDir !== runtimeSelection.localTlsDir
  ) {
    throw new Error("MCP adapter mutation does not match its verified operation target.");
  }
  target.liveIdentity.assertCurrent();
}

export function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    credentialRevision?: McpAttachedCredentialRevision;
    operationTarget?: McpOperationTarget;
  } = {},
): void {
  assertAdapterOperationTarget(sandboxName, runtimeSelection, options.operationTarget);
  switch (adapter) {
    case "openclaw-config":
      registerOpenClawAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
        ...(options.operationTarget ? ([options.operationTarget] as const) : []),
      );
      return;
    case "hermes-config":
      registerHermesAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "deepagents-config":
      registerDeepAgentsAdapter(
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
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string>,
  initialCredentialRevision: McpAttachedCredentialRevision,
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    operationTarget?: McpOperationTarget;
  } = {},
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
    registerAgentAdapter(sandboxName, adapter, entry, runtimeSelection, envValues, {
      replaceExisting,
      teardownRollback: options.teardownRollback === true,
      credentialRevision,
      ...(options.operationTarget ? { operationTarget: options.operationTarget } : {}),
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

export function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): AdapterRemovalOutcome {
  assertAdapterOperationTarget(sandboxName, runtimeSelection, options.operationTarget);
  switch (adapter) {
    case "openclaw-config":
      unregisterOpenClawAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "deepagents-config":
      return unregisterDeepAgentsAdapter(sandboxName, entry, runtimeSelection, options);
  }
}
