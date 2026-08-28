// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider attachment mutations are guarded by immutable provider identity and
 * credential-shape inspection before and after each OpenShell command. Keep
 * this compensation until attachment mutations expose an immutable-ID CAS API.
 */

import { isDeepStrictEqual } from "node:util";
import { stripAnsi } from "../../adapters/openshell/client";
import { captureSandboxBasePolicy } from "../../adapters/openshell/policy-authority";
import { runOpenshellProviderCommand } from "../../adapters/openshell/provider-command";
import * as policies from "../../policy";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  inspectMcpProvider,
  inspectMcpProviderAttachments,
  type McpProviderAttachment,
  type McpProviderAttachmentInspection,
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

type ProviderPolicyMutationAction = "attach" | "detach";

interface ProviderPolicyReceiptMutation {
  authority: policies.PolicyMutationAuthority;
  basePolicy: string;
}

class ProviderPolicyReceiptBoundaryRefusalError extends McpBridgeError {
  readonly preserveProviderAttachment = true as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderPolicyReceiptBoundaryRefusalError";
  }
}

export function isProviderPolicyReceiptBoundaryRefusalError(
  error: unknown,
): error is ProviderPolicyReceiptBoundaryRefusalError {
  return error instanceof ProviderPolicyReceiptBoundaryRefusalError;
}

function authorityFromCompensationBoundary(
  boundary: policies.ManagedPolicyCompensationBoundary,
): policies.PolicyMutationAuthority {
  return {
    authority: "nemoclaw-managed",
    authorityRecordedNow: false,
    gatewayName: boundary.gatewayName,
    inspection: { ...boundary.inspection, authority: "nemoclaw-managed" },
    policyCreationReceipt: boundary.policyCreationReceipt,
  };
}

function rollbackFailure(operation: string, primaryError: unknown, rollbackError: unknown): Error {
  const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
  const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  return new McpBridgeError(
    `${operation} changed the sandbox before its policy receipt could be completed (${primary}). ` +
      `The exact provider-attachment compensation also failed (${rollback}). The managed MCP transaction remains incomplete.`,
  );
}

function attachProviderExact(sandboxName: string, entry: McpBridgeEntry): boolean {
  if (!entry.providerName) return false;
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
  const before = exactAttachment(sandboxName, entry);
  if (!before.inspection.attachments) {
    throw new McpBridgeError(
      before.inspection.error ?? `Could not inspect provider attachment '${entry.providerName}'.`,
    );
  }
  const attachmentAlreadyExact = attachmentMatchesCurrentProviderSnapshot(before.attachment, entry);
  if (before.attachment && !attachmentAlreadyExact) {
    throw new McpBridgeError(
      `Provider attachment '${entry.providerName}' does not match MCP server '${entry.server}'. Expected stable provider ID '${entry.providerId}', found '${before.attachment.providerId ?? "missing"}', with credential keys '${before.attachment.credentialKeys.join(", ") || "none"}'.`,
    );
  }
  if (attachmentAlreadyExact) return false;
  const result = runOpenshellProviderCommand(
    ["sandbox", "provider", "attach", sandboxName, entry.providerName],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    const afterError = exactAttachment(sandboxName, entry);
    if (attachmentMatchesCurrentProviderSnapshot(afterError.attachment, entry)) {
      return true;
    }
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
  return true;
}

export function attachProvider(sandboxName: string, entry: McpBridgeEntry): void {
  if (!entry.providerName) return;
  const operation = `attach MCP provider '${entry.providerName}'`;
  const mutation = prepareProviderPolicyReceiptMutation(sandboxName, operation);
  const attachmentChanged = attachProviderExact(sandboxName, entry);
  if (!attachmentChanged) return;
  finishProviderPolicyReceiptMutation(sandboxName, entry, "attach", operation, mutation, true);
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

function detachProviderExact(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { allowLegacyGeneric?: boolean; bestEffort?: boolean } = {},
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
    const provider = inspectMcpProvider(entry.providerName);
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
    const before = exactAttachment(sandboxName, entry);
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
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
      } as Record<string, unknown>,
    ) as OpenShellCommandResult;
    const output = commandOutput(result);
    const after = exactAttachment(sandboxName, entry);
    if (after.inspection.attachments && !after.attachment) {
      return "detached";
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

function compensateExactAttachedProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  operation: string,
  primaryError: unknown,
  boundary: policies.ManagedPolicyCompensationBoundary,
  expectedReceipt: policies.PolicyMutationAuthority["policyCreationReceipt"],
): policies.PolicyMutationAuthority {
  if (
    expectedReceipt != null &&
    !isDeepStrictEqual(boundary.policyCreationReceipt, expectedReceipt)
  ) {
    throw new ProviderPolicyReceiptBoundaryRefusalError(
      `${operation} changed the provider attachment, but the durable policy receipt changed before exact compensation. The managed MCP transaction remains incomplete.`,
    );
  }
  const observed = exactAttachment(sandboxName, entry);
  if (!observed.inspection.attachments) {
    throw new McpBridgeError(
      observed.inspection.error ??
        `Could not inspect provider attachment '${entry.providerName}' for exact compensation.`,
    );
  }
  const exact = attachmentMatchesCurrentProviderSnapshot(observed.attachment, entry);
  if (observed.attachment && !exact) {
    throw new McpBridgeError(
      `Provider attachment '${entry.providerName}' changed before exact compensation.`,
    );
  }
  if (!exact) throw primaryError;
  const outcome = detachProviderExact(sandboxName, entry);
  if (outcome !== "detached" && outcome !== "absent") {
    throw new McpBridgeError(
      `Could not confirm exact compensation for provider attachment '${entry.providerName}'.`,
    );
  }
  return policies.recheckPolicyMutationAuthority(
    sandboxName,
    operation,
    authorityFromCompensationBoundary(boundary),
  );
}

function prepareProviderPolicyReceiptMutation(
  sandboxName: string,
  operation: string,
): ProviderPolicyReceiptMutation {
  const authority = policies.inspectPolicyMutationAuthority(sandboxName, operation);
  policies.assertNemoClawManagedPolicy(authority, operation);
  const basePolicy = captureSandboxBasePolicy(sandboxName, authority.gatewayName);
  policies.recheckPolicyMutationAuthority(sandboxName, operation, authority);
  return { authority, basePolicy };
}

function providerMutationMatches(
  sandboxName: string,
  entry: McpBridgeEntry,
  action: ProviderPolicyMutationAction,
): boolean {
  const observed = exactAttachment(sandboxName, entry);
  if (!observed.inspection.attachments) return false;
  const exact = attachmentMatchesCurrentProviderSnapshot(observed.attachment, entry);
  if (observed.attachment && !exact) return false;
  return action === "attach" ? exact : !observed.attachment;
}

function finishProviderPolicyReceiptMutation(
  sandboxName: string,
  entry: McpBridgeEntry,
  action: ProviderPolicyMutationAction,
  operation: string,
  mutation: ProviderPolicyReceiptMutation,
  compensatePreCasAttach: boolean,
): void {
  try {
    policies.finalizePolicyMutationReceipt(sandboxName, mutation.basePolicy, mutation.authority);
  } catch (error) {
    if (policies.isPolicyMutationReceiptFinalVerificationError(error)) {
      try {
        policies.recheckPolicyMutationAuthority(sandboxName, operation, mutation.authority);
        if (providerMutationMatches(sandboxName, entry, action)) return;
      } catch {
        // The rotated receipt is not coherent. Preserve the incomplete state.
      }
      throw error;
    }
    if (!compensatePreCasAttach) throw error;
    try {
      const boundary = policies.inspectManagedPolicyCompensationBoundary(
        sandboxName,
        operation,
        mutation.authority.gatewayName,
      );
      compensateExactAttachedProvider(
        sandboxName,
        entry,
        operation,
        error,
        boundary,
        mutation.authority.policyCreationReceipt,
      );
    } catch (rollbackError) {
      if (isProviderPolicyReceiptBoundaryRefusalError(rollbackError)) throw rollbackError;
      throw rollbackFailure(operation, error, rollbackError);
    }
    throw error;
  }
}

/**
 * Undo an exact attachment left by an interrupted incomplete add before the
 * normal add path reads or mutates receipt-bound policy state.
 */
export function reconcileIncompleteAddProviderAttachment(
  sandboxName: string,
  entry: McpBridgeEntry,
): void {
  if (entry.addState !== "preflighted" || !entry.providerName || !entry.providerId) return;
  const operation = `resume MCP provider '${entry.providerName}' attachment`;
  try {
    const authority = policies.inspectPolicyMutationAuthority(sandboxName, operation);
    policies.assertNemoClawManagedPolicy(authority, operation);
  } catch (error) {
    const boundary = policies.inspectManagedPolicyCompensationBoundary(sandboxName, operation);
    if (
      boundary.policyCreationReceipt.policyHash === boundary.inspection.policyIdentity.hash &&
      boundary.policyCreationReceipt.policyVersion ===
        boundary.inspection.policyIdentity.activeVersion
    ) {
      throw error;
    }
    try {
      compensateExactAttachedProvider(
        sandboxName,
        entry,
        operation,
        error,
        boundary,
        boundary.policyCreationReceipt,
      );
    } catch (rollbackError) {
      throw rollbackFailure(operation, error, rollbackError);
    }
  }
}

export function detachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { allowLegacyGeneric?: boolean; bestEffort?: boolean } = {},
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  const operation = `detach MCP provider '${entry.providerName}'`;
  let mutation: ProviderPolicyReceiptMutation;
  try {
    mutation = prepareProviderPolicyReceiptMutation(sandboxName, operation);
  } catch (error) {
    if (options.bestEffort) return "unknown";
    throw error;
  }
  const outcome = detachProviderExact(sandboxName, entry, options);
  if (outcome !== "detached") return outcome;
  try {
    finishProviderPolicyReceiptMutation(sandboxName, entry, "detach", operation, mutation, false);
    return outcome;
  } catch (error) {
    if (options.bestEffort) return "unknown";
    throw error;
  }
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
  const operation = `detach missing MCP provider reference '${entry.providerName}'`;
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
  const mutation = prepareProviderPolicyReceiptMutation(sandboxName, operation);
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
  const outcome = providerDetachChangedState(result.status, output) ? "detached" : "absent";
  finishProviderPolicyReceiptMutation(sandboxName, entry, "detach", operation, mutation, false);
  return outcome;
}
