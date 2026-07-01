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
} from "./mcp-bridge-adapter-inspection";
import {
  inspectOpenClawAdapterRegistration,
  registerOpenClawAdapter,
  unregisterOpenClawAdapter,
} from "./mcp-bridge-adapter-openclaw";

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
  DEEPAGENTS_MCP_CONFIG_PATH,
  mcporterHeadersMatchExpected,
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
 * Refuse an in-sandbox adapter config mutation while Hermes config is locked.
 * This host-side check intentionally runs before provider, policy, attachment,
 * or adapter work; the transaction helper repeats the file-level check to
 * close posture drift between this preflight and the actual config write.
 *
 * Deep Agents and OpenClaw do not use the Hermes shields contract. In
 * particular, teardown of a legacy Deep Agents entry must remain possible on
 * an image that predates the managed launcher capability marker.
 */
export function assertAgentMcpConfigMutationAllowed(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  if (adapter === "hermes-config") assertHermesMcpConfigMutationAllowed(sandboxName);
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
  options: { replaceExisting?: boolean } = {},
): void {
  switch (adapter) {
    case "mcporter":
      registerOpenClawAdapter(sandboxName, entry, envValues, options.replaceExisting === true);
      return;
    case "hermes-config":
      registerHermesAdapter(sandboxName, entry, envValues, options.replaceExisting === true);
      return;
    case "deepagents-config":
      registerDeepAgentsAdapter(sandboxName, entry, envValues, options.replaceExisting === true);
      return;
  }
}

export function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): void {
  switch (adapter) {
    case "mcporter":
      unregisterOpenClawAdapter(sandboxName, entry, options);
      return;
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, options);
      return;
    case "deepagents-config":
      unregisterDeepAgentsAdapter(sandboxName, entry, options);
      return;
  }
}
