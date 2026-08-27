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
  assertHermesMcpConfigMutationAllowed,
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
  assertOpenClawMcpConfigMutationAllowed,
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
import { waitForMcpBridgeCondition } from "./mcp-bridge/timing";

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

export function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  switch (adapter) {
    case "mcporter":
      return inspectOpenClawAdapterRegistration(sandboxName, entry);
    case "hermes-config":
      return inspectHermesAdapterRegistration(sandboxName, entry);
    case "deepagents-config":
      return inspectDeepAgentsAdapterRegistration(sandboxName, entry);
  }
}

/**
 * Refuse an in-sandbox adapter config mutation while the agent config is
 * locked. This host-side check intentionally runs before provider, policy,
 * attachment, or adapter work; the Hermes transaction helper repeats the
 * file-level check to close posture drift between this preflight and the
 * actual config write.
 *
 * Every path that mutates a managed adapter definition — `mcp add`, `mcp
 * remove`, `mcp restart`, rebuild preparation, and both destroy preflights —
 * funnels through this predicate, so covering an adapter here covers the whole
 * class for that adapter.
 *
 * Deep Agents is exempt: its managed projection is
 * `/sandbox/.deepagents/.nemoclaw-mcp.json`, the agent ships no
 * `state-lock-plan.json`, and no shields posture makes that path unwritable.
 * Teardown of a legacy Deep Agents entry must also remain possible on an image
 * that predates the managed launcher capability marker.
 */
export function assertAgentMcpConfigMutationAllowed(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  switch (adapter) {
    case "hermes-config":
      assertHermesMcpConfigMutationAllowed(sandboxName);
      return;
    case "mcporter":
      assertOpenClawMcpConfigMutationAllowed(sandboxName);
      return;
    case "deepagents-config":
      return;
  }
}

export function assertAgentMcpMutationRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  switch (adapter) {
    case "deepagents-config":
      assertDeepAgentsMcpMutationRuntimeCapability(sandboxName);
      return;
    case "hermes-config":
      assertHermesMcpMutationRuntimeCapability(sandboxName);
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
export function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  assertAgentMcpConfigMutationAllowed(sandboxName, adapter);
  if (adapter === "hermes-config") {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);
  }
}

export function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    credentialRevision?: McpAttachedCredentialRevision;
  } = {},
): void {
  switch (adapter) {
    case "mcporter":
      registerOpenClawAdapter(
        sandboxName,
        entry,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "hermes-config":
      registerHermesAdapter(
        sandboxName,
        entry,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "deepagents-config":
      registerDeepAgentsAdapter(
        sandboxName,
        entry,
        envValues,
        options.replaceExisting === true,
        options.teardownRollback === true,
        options.credentialRevision,
      );
      return;
  }
}

/** Register one adapter and converge it on the credential revision exposed by fresh execs. */
export function registerAgentAdapterAtCurrentCredentialRevision(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  envValues: Record<string, string>,
  initialCredentialRevision: McpAttachedCredentialRevision,
  options: { replaceExisting?: boolean; teardownRollback?: boolean } = {},
): McpAttachedCredentialRevision {
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
    registerAgentAdapter(sandboxName, adapter, entry, envValues, {
      replaceExisting,
      teardownRollback: options.teardownRollback === true,
      credentialRevision,
    });
    let candidateRevision: McpAttachedCredentialRevision | undefined;
    let stableObservations = 0;
    let observedRevision: McpAttachedCredentialRevision | undefined;
    const stable = waitForMcpBridgeCondition(
      () => {
        const observation = observeMcpCredentialRevision(sandboxName, entry);
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
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): AdapterRemovalOutcome {
  switch (adapter) {
    case "mcporter":
      unregisterOpenClawAdapter(sandboxName, entry, options);
      return "removed";
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, options);
      return "removed";
    case "deepagents-config":
      return unregisterDeepAgentsAdapter(sandboxName, entry, options);
  }
}
