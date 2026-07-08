// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenShell v0.0.72 provider mutations have no compare-and-swap operation, so
 * another client can race between NemoClaw's preinspection and mutation. A
 * nonzero mutation result is therefore ambiguous and always fails closed;
 * NemoClaw never infers success from a later resource-version increase.
 * Randomized provider names, the MCP lifecycle lock, and mandatory
 * postinspection of immutable identity, credential shape, and resource version
 * constrain this TOCTOU boundary. Remove the compensation when OpenShell
 * exposes provider CAS or immutable provider IDs as mutation targets.
 */

import { runOpenshellProviderCommand } from "../../actions/global";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError, type ParsedEnvReference } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  inspectMcpProvider,
  type McpProviderInspection,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider-inspection";
import {
  assertPersistedAuthenticatedBridgeEntry,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpCredentialEnvName,
} from "./mcp-bridge-validation";

export type { ProviderDetachOutcome } from "./mcp-bridge-provider-attachments";
export {
  attachProvider,
  detachMissingProviderReference,
  detachProvider,
  providerDetachChangedState,
} from "./mcp-bridge-provider-attachments";

export function buildMcpBridgeProviderArgs(
  action: "create" | "update",
  providerName: string,
  env: readonly ParsedEnvReference[],
  envValues: Record<string, string>,
): string[] {
  const args =
    action === "create"
      ? ["provider", "create", "--name", providerName, "--type", "generic"]
      : ["provider", "update", providerName];
  for (const entry of env) {
    validateMcpCredentialEnvName(entry.name);
    const value = envValues[entry.name];
    if (value !== undefined && value !== "") {
      args.push("--credential", entry.name);
    }
  }
  return args;
}

export function upsertMcpProvider(
  providerName: string,
  env: readonly ParsedEnvReference[],
  options: {
    allowExisting: boolean;
    expectedProviderId?: string;
    prepareMutation?: (action: "create" | "update") => void;
  },
): {
  action: "created" | "updated" | "reused" | "none";
  inspection: McpProviderInspection;
} {
  const envNames = uniqueEnvNames(env);
  if (envNames.length === 0) {
    return {
      action: "none",
      inspection: {
        exists: false,
        id: null,
        resourceVersion: null,
        type: null,
        credentialKeys: null,
      },
    };
  }
  const envValues = resolveCredentialEnv(env);
  const inspection = inspectMcpProvider(providerName);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${providerName}'.`,
    );
  }
  if (inspection.exists && !options.allowExisting) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' already exists but is not owned by a registered MCP bridge. Remove or rename that provider before retrying.`,
    );
  }
  if (inspection.exists && !options.expectedProviderId) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' already exists, but the incomplete MCP add has no stable provider ID and cannot safely adopt it. Remove that provider independently, then retry the original mcp add command.`,
    );
  }
  if (
    inspection.exists &&
    !providerMatchesCredential(inspection, envNames[0], options.expectedProviderId)
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' no longer exactly matches MCP server credential '${envNames[0]}'. ${providerShapeDetail(inspection, envNames[0], options.expectedProviderId)} Remove the stale provider and run mcp restart with the credential exported.`,
    );
  }
  if (Object.keys(envValues).length === 0) {
    if (inspection.exists) return { action: "reused", inspection };
    throw new McpBridgeError(
      `Host environment variable '${envNames[0]}' is required to create MCP provider '${providerName}'.`,
      1,
    );
  }
  const action = inspection.exists ? "update" : "create";
  // Let callers establish policy and revision proofs only after the actual
  // mutation kind is known. The immediate reinspection below closes races
  // that occur while those fail-closed prerequisites are being prepared.
  options.prepareMutation?.(action);
  // invalidState: another OpenShell client replaces a mutable provider name
  // between inspection and mutation. sourceBoundary: OpenShell owns provider
  // compare-and-swap; v0.0.72 exposes no provider CAS flags. whyNotSourceFix:
  // NemoClaw cannot atomically mutate the upstream store, so it uses randomized
  // names, a lifecycle mutex, and immutable-ID/resource-version reinspection.
  // regressionTest: mcp-provider-ownership.test.ts simulates a concurrent
  // resource-version writer and requires the ambiguous update to fail closed.
  // removalCondition: use native immutable provider IDs/CAS once OpenShell
  // exposes them, then remove this inspect-mutate-inspect compensation.
  const beforeMutation = inspectMcpProvider(providerName);
  if (action === "create" && beforeMutation.exists !== false) {
    const detail =
      beforeMutation.exists === null
        ? (beforeMutation.error ?? "provider inspection failed")
        : "a same-name provider appeared after preflight";
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed before create: ${detail}. Refusing to mutate it.`,
    );
  }
  if (
    action === "update" &&
    !providerMatchesCredential(beforeMutation, envNames[0], options.expectedProviderId)
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed before update. ${providerShapeDetail(beforeMutation, envNames[0], options.expectedProviderId)} Refusing to mutate it.`,
    );
  }
  const result = runOpenshellProviderCommand(
    buildMcpBridgeProviderArgs(action, providerName, env, envValues),
    {
      ignoreError: true,
      env: envValues,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    // Never infer that our update committed from a later resource-version
    // increase: a concurrent writer can advance the same provider after our
    // command failed. A non-zero result is ambiguous and must fail closed.
    throw new McpBridgeError(
      commandOutput(result, envValues) || `Failed to ${action} MCP provider '${providerName}'.`,
    );
  }
  const after = inspectMcpProvider(providerName);
  if (after.exists !== true || !after.id) {
    throw new McpBridgeError(
      after.error ??
        `OpenShell did not return a stable provider ID after ${action} for '${providerName}'. Refusing later MCP side effects.`,
    );
  }
  const expectedProviderId = action === "create" ? after.id : options.expectedProviderId;
  if (
    !after.resourceVersion ||
    !providerMatchesCredential(after, envNames[0], expectedProviderId) ||
    (action === "update" && after.resourceVersion <= (beforeMutation.resourceVersion ?? 0))
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed during ${action}. ${providerShapeDetail(after, envNames[0], expectedProviderId)} Refusing later MCP side effects.`,
    );
  }
  return { action: action === "create" ? "created" : "updated", inspection: after };
}

function inspectMcpProviderForDeletion(
  entry: McpBridgeEntry,
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): McpProviderInspection | null {
  if (!entry.providerName) return null;
  try {
    assertPersistedAuthenticatedBridgeEntry(entry);
    if (!entry.providerId) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to delete same-name provider '${entry.providerName}'.`,
      );
    }
    const inspection = inspectMcpProvider(entry.providerName);
    if (inspection.exists === false) {
      if (options.allowMissing) return inspection;
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' disappeared before delete.`,
      );
    }
    if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' changed before delete. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)} Refusing to mutate it.`,
      );
    }
    return inspection;
  } catch (error) {
    if (options.bestEffort) return null;
    throw error;
  }
}

export function deleteProvider(
  entry: McpBridgeEntry,
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): void {
  if (!entry.providerName) return;
  const inspection = inspectMcpProviderForDeletion(entry, options);
  if (!inspection?.exists || !inspection.id || !inspection.resourceVersion) return;
  const result = runOpenshellProviderCommand(["provider", "delete", entry.providerName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    suppressOutput: true,
  } as Record<string, unknown>) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    if (options.allowMissing && /not\s+found|NotFound/i.test(output)) return;
    if (options.bestEffort) return;
    throw new McpBridgeError(output || `Failed to delete MCP provider '${entry.providerName}'.`);
  }
  const after = inspectMcpProvider(entry.providerName);
  if (after.exists !== false && !options.bestEffort) {
    throw new McpBridgeError(
      after.error ?? `OpenShell provider '${entry.providerName}' still exists after delete.`,
    );
  }
}
