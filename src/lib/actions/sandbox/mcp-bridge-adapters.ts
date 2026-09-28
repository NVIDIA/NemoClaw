// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  assertHermesMcpTeardownRuntimeCapability,
  inspectHermesAdapterRegistration,
  reloadHermesGatewayAfterMcpRestart,
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
  buildHermesMcpReconcileCommand,
  buildHermesMcpRegisterCommand,
  beginHermesMcpReloadFinalityDeadline,
  HermesMcpReloadRelayLossError,
  inspectHermesMcpReloadFinality,
  type HermesMcpReloadFinalityDeadline,
  type HermesMcpReloadFinalityInspection,
} from "./mcp-bridge-adapter-hermes";
export {
  type AdapterRegistrationInspection,
  parseAdapterRegistrationInspection,
} from "./mcp-bridge-adapter-inspection";
export { MCPORTER_VERSION } from "./mcp-bridge-adapter-openclaw";
export {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcpInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEEPAGENTS_MCP_CONFIG_PATH,
  openClawHeadersMatchExpected,
  openClawConfigDir,
} from "./mcp-bridge-adapter-status";

export async function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  credentialRevision?: McpAttachedCredentialRevision,
  timeoutMs?: number,
): Promise<AdapterRegistrationInspection> {
  switch (adapter) {
    case "openclaw-config":
      return inspectOpenClawAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "hermes-config":
      return await inspectHermesAdapterRegistration(
        sandboxName,
        entry,
        runtimeSelection,
        credentialRevision,
        timeoutMs,
      );
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
export async function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (adapter === "hermes-config") {
    assertHermesMcpTeardownRuntimeCapability(sandboxName, runtimeSelection);
  }
}

export async function reloadOpenClawGatewayAfterMcpMutation(
  sandboxName: string,
  adapters: readonly AgentMcpAdapter[],
): Promise<void> {
  if (adapters.includes("openclaw-config")) await reloadOpenClawGateway(sandboxName);
}

export { reloadHermesGatewayAfterMcpRestart };

export async function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    credentialRevision?: McpAttachedCredentialRevision;
  } = {},
): Promise<void> {
  switch (adapter) {
    case "openclaw-config":
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
  entry: McpSourceEntry,
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
    const observedRevision = await observeStableMcpCredentialRevision(
      sandboxName,
      entry,
      runtimeSelection,
      timeoutSeconds,
    );
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

/** Require three fresh-exec observations of one credential revision one second apart. */
export async function observeStableMcpCredentialRevision(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  timeoutSeconds: number,
  expectedRevision?: McpAttachedCredentialRevision,
  deadline?: { readonly deadlineMs: number; readonly now: () => number },
): Promise<McpAttachedCredentialRevision> {
  let candidateRevision: McpAttachedCredentialRevision | undefined;
  let stableObservations = 0;
  let observedRevision: McpAttachedCredentialRevision | undefined;
  const observationTimeoutMs = (): number | undefined => {
    if (!deadline) return undefined;
    const remainingMs = Math.floor(deadline.deadlineMs - deadline.now());
    if (remainingMs <= 0) throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    return remainingMs;
  };
  const observeStableRevision = async (): Promise<boolean> => {
    const observation = await observeMcpCredentialRevision(
      sandboxName,
      entry,
      runtimeSelection,
      observationTimeoutMs(),
    );
    if (observation === "absent" || observation === "canonical") {
      throw mcpAdapterCredentialRevisionUnavailableError(entry.server);
    }
    if (expectedRevision !== undefined && observation !== expectedRevision) {
      throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    }
    if (candidateRevision !== observation) {
      candidateRevision = observation;
      stableObservations = 1;
      return false;
    }
    stableObservations += 1;
    if (stableObservations < STABLE_CREDENTIAL_REVISION_OBSERVATIONS) return false;
    observedRevision = observation;
    return true;
  };
  const stable = deadline
    ? await waitForMcpBridgeConditionAsync(observeStableRevision, {
        backoffFactor: 1,
        deadlineMs: deadline.deadlineMs,
        initialIntervalMs: 1_000,
        maxIntervalMs: 1_000,
        now: deadline.now,
      })
    : await waitForMcpBridgeConditionAsync(
        observeStableRevision,
        Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
        1_000,
      );
  if (
    !stable ||
    observedRevision === undefined ||
    (deadline !== undefined && deadline.now() >= deadline.deadlineMs)
  ) {
    throw mcpAdapterCredentialRevisionUnstableError(entry.server);
  }
  return observedRevision;
}

export async function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): Promise<AdapterRemovalOutcome> {
  switch (adapter) {
    case "openclaw-config":
      unregisterOpenClawAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "deepagents-config":
      return await unregisterDeepAgentsAdapter(sandboxName, entry, runtimeSelection, options);
  }
}
