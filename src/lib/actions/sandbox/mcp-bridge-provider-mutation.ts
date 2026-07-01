// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import { stripAnsi } from "../../adapters/openshell/client";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError, type ParsedEnvReference } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  type McpProviderAttachment,
  type McpProviderAttachmentInspection,
  type McpProviderInspection,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider-inspection";
import {
  assertAuthenticatedBridgeEntry,
  assertPersistedAuthenticatedBridgeEntry,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpCredentialEnvName,
} from "./mcp-bridge-validation";

function exactAttachment(
  sandboxName: string,
  entry: McpBridgeEntry,
): { inspection: McpProviderAttachmentInspection; attachment?: McpProviderAttachment } {
  const inspection = inspectMcpProviderAttachments(sandboxName);
  return {
    inspection,
    attachment: inspection.attachments?.find(
      (attachment) => attachment.name === entry.providerName,
    ),
  };
}

function attachmentMatchesCurrentProviderSnapshot(
  attachment: McpProviderAttachment | undefined,
  entry: McpBridgeEntry,
): boolean {
  return (
    !!attachment &&
    attachment.providerId === entry.providerId &&
    entry.env.length === 1 &&
    attachment.credentialKeys.length === 1 &&
    attachment.credentialKeys[0] === entry.env[0]
  );
}

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

function inspectMcpProviderForMutation(
  entry: McpBridgeEntry,
  operation: "attach" | "detach" | "delete",
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): McpProviderInspection | null {
  if (!entry.providerName) return null;
  try {
    if (operation === "attach") assertAuthenticatedBridgeEntry(entry);
    else assertPersistedAuthenticatedBridgeEntry(entry);
    if (!entry.providerId) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to ${operation} same-name provider '${entry.providerName}'.`,
      );
    }
    const inspection = inspectMcpProvider(entry.providerName);
    if (inspection.exists === false) {
      if (options.allowMissing) return inspection;
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' disappeared before ${operation}.`,
      );
    }
    if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' changed before ${operation}. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)} Refusing to mutate it.`,
      );
    }
    return inspection;
  } catch (error) {
    if (options.bestEffort) return null;
    throw error;
  }
}

export function attachProvider(sandboxName: string, entry: McpBridgeEntry): void {
  if (!entry.providerName) return;
  const inspection = inspectMcpProviderForMutation(entry, "attach");
  if (!inspection?.id || !inspection.resourceVersion) {
    throw new McpBridgeError(`OpenShell provider '${entry.providerName}' has incomplete metadata.`);
  }
  const result = runOpenshellProviderCommand(
    ["sandbox", "provider", "attach", sandboxName, entry.providerName],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    const afterError = exactAttachment(sandboxName, entry);
    if (attachmentMatchesCurrentProviderSnapshot(afterError.attachment, entry)) return;
    throw new McpBridgeError(
      output ||
        afterError.inspection.error ||
        `Failed to attach MCP provider '${entry.providerName}'.`,
    );
  }
  const after = exactAttachment(sandboxName, entry);
  if (!attachmentMatchesCurrentProviderSnapshot(after.attachment, entry)) {
    throw new McpBridgeError(
      after.inspection.error ??
        `OpenShell did not persist the expected provider identity and credential shape for '${entry.providerName}' after attach.`,
    );
  }
}

export function providerDetachChangedState(status: number | null, output: string): boolean {
  return (
    status === 0 &&
    !/\bwas\s+not\s+attached\b|\balready\s+detached\b|\bNotAttached\b/i.test(stripAnsi(output))
  );
}

export type ProviderDetachOutcome = "detached" | "absent" | "unknown";

export function detachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { bestEffort?: boolean } = {},
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no recorded provider ID for prechecked detach.`,
    );
  }
  const before = exactAttachment(sandboxName, entry);
  if (!before.inspection.attachments) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      before.inspection.error ?? `Could not inspect provider attachment '${entry.providerName}'.`,
    );
  }
  if (!before.attachment) return "absent";
  if (
    before.attachment.providerId !== entry.providerId ||
    before.attachment.credentialKeys.length !== 1 ||
    before.attachment.credentialKeys[0] !== entry.env[0]
  ) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `Provider attachment '${entry.providerName}' does not match MCP server '${entry.server}'. Expected stable provider ID '${entry.providerId}', found '${before.attachment.providerId ?? "missing"}', with credential keys '${before.attachment.credentialKeys.join(", ") || "none"}'.`,
    );
  }
  const result = runOpenshellProviderCommand(
    ["sandbox", "provider", "detach", sandboxName, entry.providerName],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    } as Record<string, unknown>,
  ) as OpenShellCommandResult;
  const output = commandOutput(result);
  const after = exactAttachment(sandboxName, entry);
  if (after.inspection.attachments && !after.attachment) {
    return providerDetachChangedState(result.status, output) ? "detached" : "absent";
  }
  if (options.bestEffort) return "unknown";
  throw new McpBridgeError(
    output ||
      after.inspection.error ||
      `OpenShell did not confirm removal of provider attachment '${entry.providerName}'.`,
  );
}

/**
 * Remove a dangling provider name from the sandbox spec after the provider
 * object itself has been independently proven absent. OpenShell main cannot
 * list attachments while a referenced provider is missing, but its detach
 * command removes the name directly from the sandbox spec under CAS.
 */
export function detachMissingProviderReference(
  sandboxName: string,
  entry: McpBridgeEntry,
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  const before = inspectMcpProvider(entry.providerName);
  if (before.exists !== false) {
    const detail =
      before.exists === null
        ? (before.error ?? "provider inspection failed")
        : `provider ID '${before.id ?? "unparseable"}' is present`;
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is not provably absent before dangling-reference cleanup: ${detail}.`,
    );
  }
  const result = runOpenshellProviderCommand(
    ["sandbox", "provider", "detach", sandboxName, entry.providerName],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as OpenShellCommandResult;
  const output = commandOutput(result);
  if (result.status !== 0) {
    throw new McpBridgeError(
      output || `Failed to remove dangling provider reference '${entry.providerName}'.`,
    );
  }
  const afterProvider = inspectMcpProvider(entry.providerName);
  if (afterProvider.exists !== false) {
    throw new McpBridgeError(
      afterProvider.error ??
        `A same-name provider appeared while removing dangling reference '${entry.providerName}'. Refusing to create or adopt it.`,
    );
  }
  const cleanOutput = stripAnsi(output);
  if (!/\bDetached provider\b|\bwas not attached to sandbox\b/i.test(cleanOutput)) {
    throw new McpBridgeError(
      `OpenShell returned an unrecognized result while removing dangling provider reference '${entry.providerName}'.`,
    );
  }
  return providerDetachChangedState(result.status, output) ? "detached" : "absent";
}

export function deleteProvider(
  entry: McpBridgeEntry,
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): void {
  if (!entry.providerName) return;
  const inspection = inspectMcpProviderForMutation(entry, "delete", options);
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
