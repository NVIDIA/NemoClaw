// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider attachment mutations are guarded by immutable provider identity and
 * credential-shape inspection before and after each OpenShell command. Keep
 * this compensation until attachment mutations expose an immutable-ID CAS API.
 */

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  createMcpProviderAdapterBoundary,
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

async function exactAttachment(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<{ inspection: McpProviderAttachmentInspection; attachment?: McpProviderAttachment }> {
  const inspection = await inspectMcpProviderAttachments(
    sandboxName,
    runtimeSelection,
    providerAdapter,
  );
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

export async function attachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<void> {
  if (!entry.providerName) return;
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to attach same-name provider '${entry.providerName}'.`,
    );
  }
  const boundary = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const inspection = await inspectMcpProvider(
    entry.providerName,
    runtimeSelection,
    boundary.adapter,
  );
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
  const result = await boundary.adapter.attachProvider({
    providerName: entry.providerName,
    sandboxName,
    target: boundary.target,
  });
  if (!result.ok) {
    const afterError = await exactAttachment(
      sandboxName,
      entry,
      runtimeSelection,
      boundary.adapter,
    );
    if (attachmentMatchesCurrentProviderSnapshot(afterError.attachment, entry)) return;
    throw new McpBridgeError(
      result.error.message ||
        afterError.inspection.error ||
        `Failed to attach MCP provider '${entry.providerName}'.`,
    );
  }
  const after = await exactAttachment(sandboxName, entry, runtimeSelection, boundary.adapter);
  if (!attachmentMatchesCurrentProviderSnapshot(after.attachment, entry)) {
    throw new McpBridgeError(
      after.inspection.error ??
        `OpenShell did not persist the expected provider identity and credential shape for '${entry.providerName}' after attach.`,
    );
  }
}

export type ProviderDetachOutcome = "detached" | "absent" | "unknown";

const MCP_PROVIDER_DETACH_ATTEMPTS = 2;

export async function detachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: {
    allowLegacyGeneric?: boolean;
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
    providerAdapter?: OpenShellProviderAdapter;
  },
): Promise<ProviderDetachOutcome> {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no recorded provider ID for prechecked detach.`,
    );
  }
  const boundary = createMcpProviderAdapterBoundary(
    options.runtimeSelection,
    options.providerAdapter,
  );
  for (let attempt = 0; attempt < MCP_PROVIDER_DETACH_ATTEMPTS; attempt += 1) {
    const provider = await inspectMcpProvider(
      entry.providerName,
      options.runtimeSelection,
      boundary.adapter,
    );
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
    const before = await exactAttachment(
      sandboxName,
      entry,
      options.runtimeSelection,
      boundary.adapter,
    );
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
    const result = await boundary.adapter.detachProvider({
      providerName: entry.providerName,
      sandboxName,
      target: boundary.target,
    });
    const after = await exactAttachment(
      sandboxName,
      entry,
      options.runtimeSelection,
      boundary.adapter,
    );
    if (after.inspection.attachments && !after.attachment) {
      return result.ok && result.value.changed ? "detached" : "absent";
    }
    if (
      attempt + 1 < MCP_PROVIDER_DETACH_ATTEMPTS &&
      after.inspection.attachments &&
      attachmentMatchesCurrentProviderSnapshot(after.attachment, entry) &&
      !result.ok &&
      result.error.kind === "command" &&
      result.error.reason === "conflict"
    ) {
      continue;
    }
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      (!result.ok ? result.error.message : "") ||
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
export async function detachMissingProviderReference(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<ProviderDetachOutcome> {
  if (!entry.providerName) return "absent";
  assertPersistedAuthenticatedBridgeEntry(entry);
  const boundary = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const before = await inspectMcpProvider(entry.providerName, runtimeSelection, boundary.adapter);
  if (before.exists !== false) {
    const detail =
      before.exists === null
        ? (before.error ?? "provider inspection failed")
        : `provider ID '${before.id ?? "unparseable"}' is present`;
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is not provably absent before dangling-reference cleanup: ${detail}.`,
    );
  }
  const result = await boundary.adapter.detachProvider({
    providerName: entry.providerName,
    sandboxName,
    target: boundary.target,
  });
  if (!result.ok) {
    throw new McpBridgeError(
      result.error.message ||
        `Failed to remove dangling provider reference '${entry.providerName}'.`,
    );
  }
  const afterProvider = await inspectMcpProvider(
    entry.providerName,
    runtimeSelection,
    boundary.adapter,
  );
  if (afterProvider.exists !== false) {
    throw new McpBridgeError(
      afterProvider.error ??
        `A same-name provider appeared while removing dangling reference '${entry.providerName}'. Refusing to create or adopt it.`,
    );
  }
  return result.value.changed ? "detached" : "absent";
}
