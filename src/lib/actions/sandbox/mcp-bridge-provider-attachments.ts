// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider attachment mutations are guarded by immutable provider identity and
 * credential-shape inspection before and after each OpenShell command. Keep
 * this compensation until attachment mutations expose an immutable-ID CAS API.
 */

import { runOpenshellProviderCommand } from "../../actions/global";
import { stripAnsi } from "../../adapters/openshell/client";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  type McpProviderAttachment,
  type McpProviderAttachmentInspection,
  providerMatchesCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider-inspection";
import {
  assertAuthenticatedBridgeEntry,
  assertPersistedAuthenticatedBridgeEntry,
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

export function attachProvider(sandboxName: string, entry: McpBridgeEntry): void {
  if (!entry.providerName) return;
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to attach same-name provider '${entry.providerName}'.`,
    );
  }
  const inspection = inspectMcpProvider(entry.providerName);
  if (inspection.exists === false) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' disappeared before attach.`,
    );
  }
  if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' changed before attach. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)} Refusing to mutate it.`,
    );
  }
  if (!inspection.id || !inspection.resourceVersion) {
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
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
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
