// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider attachment mutations are guarded by immutable provider identity and
 * credential-shape inspection before and after each OpenShell command. Keep
 * this compensation until attachment mutations expose an immutable-ID CAS API.
 */

import { stripAnsi } from "../../adapters/openshell/client";
import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  type McpProviderAttachment,
  type McpProviderAttachmentInspection,
  type McpProviderInspectionRuntimeSelection,
  providerMatchesCredential,
  providerMatchesManagedCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider-inspection";
import {
  assertAuthenticatedBridgeEntry,
  assertPersistedAuthenticatedBridgeEntry,
} from "./mcp-bridge-validation";

function exactAttachment(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): { inspection: McpProviderAttachmentInspection; attachment?: McpProviderAttachment } {
  const inspection = inspectMcpProviderAttachments(sandboxName, runtimeSelection);
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

export function attachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  if (!entry.providerName) return;
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to attach same-name provider '${entry.providerName}'.`,
    );
  }
  const inspection = inspectMcpProvider(entry.providerName, runtimeSelection);
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
    { ignoreError: true, runtimeSelection, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    const afterError = exactAttachment(sandboxName, entry, runtimeSelection);
    if (attachmentMatchesCurrentProviderSnapshot(afterError.attachment, entry)) return;
    throw new McpBridgeError(
      output ||
        afterError.inspection.error ||
        `Failed to attach MCP provider '${entry.providerName}'.`,
    );
  }
  const after = exactAttachment(sandboxName, entry, runtimeSelection);
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

const MCP_PROVIDER_DETACH_ATTEMPTS = 2;

function isRetryableSandboxMutationConflict(status: number | null, output: string): boolean {
  return (
    status !== 0 &&
    /Failed to detach provider:\s*sandbox was modified by another operation\.\s*Please retry the command\.?/i.test(
      stripAnsi(output),
    )
  );
}

export function detachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: {
    allowLegacyGeneric?: boolean;
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no recorded provider ID for prechecked detach.`,
    );
  }
  for (let attempt = 0; attempt < MCP_PROVIDER_DETACH_ATTEMPTS; attempt += 1) {
    const provider = inspectMcpProvider(entry.providerName, options.runtimeSelection);
    if (
      !providerMatchesManagedCredential(provider, entry.env[0], entry.providerId, {
        allowLegacyGeneric: options.allowLegacyGeneric,
      })
    ) {
      if (options.bestEffort) return "unknown";
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' changed before detach. ${providerShapeDetail(provider, entry.env[0], entry.providerId)} Refusing to mutate it.`,
      );
    }
    const before = exactAttachment(sandboxName, entry, options.runtimeSelection);
    if (!before.inspection.attachments) {
      if (options.bestEffort) return "unknown";
      throw new McpBridgeError(
        before.inspection.error ?? `Could not inspect provider attachment '${entry.providerName}'.`,
      );
    }
    if (!before.attachment) return "absent";
    if (!attachmentMatchesCurrentProviderSnapshot(before.attachment, entry)) {
      if (options.bestEffort) return "unknown";
      throw new McpBridgeError(
        `Provider attachment '${entry.providerName}' does not match MCP server '${entry.server}'. Expected stable provider ID '${entry.providerId}', found '${before.attachment.providerId ?? "missing"}', with credential keys '${before.attachment.credentialKeys.join(", ") || "none"}'.`,
      );
    }
    const result = runOpenshellProviderCommand(
      ["sandbox", "provider", "detach", sandboxName, entry.providerName],
      {
        ignoreError: true,
        runtimeSelection: options.runtimeSelection,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
      } as Record<string, unknown>,
    ) as OpenShellCommandResult;
    const output = commandOutput(result);
    const after = exactAttachment(sandboxName, entry, options.runtimeSelection);
    if (after.inspection.attachments && !after.attachment) {
      return providerDetachChangedState(result.status, output) ? "detached" : "absent";
    }
    if (
      attempt + 1 < MCP_PROVIDER_DETACH_ATTEMPTS &&
      after.inspection.attachments &&
      attachmentMatchesCurrentProviderSnapshot(after.attachment, entry) &&
      isRetryableSandboxMutationConflict(result.status, output)
    ) {
      continue;
    }
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      output ||
        after.inspection.error ||
        `OpenShell did not confirm removal of provider attachment '${entry.providerName}'.`,
    );
  }
  return "unknown";
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
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  const before = inspectMcpProvider(entry.providerName, runtimeSelection);
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
    { ignoreError: true, runtimeSelection, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  const output = commandOutput(result);
  if (result.status !== 0) {
    throw new McpBridgeError(
      output || `Failed to remove dangling provider reference '${entry.providerName}'.`,
    );
  }
  const afterProvider = inspectMcpProvider(entry.providerName, runtimeSelection);
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
