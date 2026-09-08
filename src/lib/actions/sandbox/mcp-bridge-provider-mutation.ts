// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenShell v0.0.99 serializes provider writes with a server-side resource-version
 * compare-and-swap, but `provider update` exposes no caller-supplied expected
 * version. Another client can therefore race between NemoClaw's preinspection
 * and mutation, and the server can merge against state NemoClaw did not approve.
 * A nonzero mutation result is ambiguous and always fails closed; NemoClaw never
 * infers success from a later resource-version increase.
 * Randomized provider names, the MCP lifecycle lock, and mandatory
 * postinspection of immutable identity, credential shape, and resource version
 * constrain this TOCTOU boundary. Remove the compensation when OpenShell
 * exposes caller-supplied provider CAS or immutable provider IDs as mutation
 * targets.
 */

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { endpointlessProviderProfilePath } from "../../adapters/openshell/provider-profile";
import { OPENAI_GATEWAY_PROVIDER_TYPE } from "../../adapters/openshell/provider-profile-registration";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError, type ParsedEnvReference } from "./mcp-bridge-contracts";
import {
  createMcpProviderAdapterBoundary,
  inspectMcpProvider,
  MCP_BRIDGE_PROVIDER_TYPE,
  type McpProviderInspectionRuntimeSelection,
  type McpProviderInspection,
  providerMatchesCredential,
  providerMatchesManagedCredential,
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
} from "./mcp-bridge-provider-attachments";

/**
 * OpenShell 0.0.106 still accepts the legacy `openai` provider type without a
 * declarative profile. Its static-credential resolver then emits the provider
 * key without endpoint metadata, causing the supervisor to reject the whole
 * provider environment as unclassified when an MCP provider is attached.
 * Registering an endpointless profile makes the gateway-only inference key
 * explicitly non-injectable while preserving OpenShell's inference route.
 *
 * invalidState: an unprofiled gateway-only inference credential revokes the
 * otherwise valid endpoint-bound MCP credential snapshot.
 * sourceBoundary: OpenShell owns provider-environment classification and
 * rejects mixed snapshots atomically.
 * whyNotSourceFix: NemoClaw must remain compatible with the pinned OpenShell
 * 0.0.106 runtime, so it declares the missing profile contract before attach.
 * regressionTest: mcp-bridge-provider-profile.test.ts proves exact existing
 * profile validation and rejects credential, endpoint, and malformed drift.
 * removalCondition: remove this import when the minimum supported OpenShell
 * release classifies the `openai` inference credential as gateway-only itself.
 */
async function ensureOpenAiGatewayProviderProfile(
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<void> {
  const { adapter, target } = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const result = await adapter.importProviderProfile({
    profilePath: endpointlessProviderProfilePath(REPOSITORY_ROOT, OPENAI_GATEWAY_PROVIDER_TYPE),
    target,
  });
  if (result.ok) return;
  if (result.error.kind === "command" && result.error.reason === "profile_incompatible") {
    throw new McpBridgeError(
      "OpenShell provider profile 'openai' already exists but does not match NemoClaw's endpointless inference contract.\n    Remove the conflicting profile, then retry this command.",
    );
  }
  throw new McpBridgeError(
    result.operation === "import"
      ? "OpenShell could not import the checked-in 'openai' inference provider profile.\n    Confirm OpenShell is available and authorized, then retry this command."
      : "OpenShell provider profile 'openai' could not be read for validation.\n    Confirm OpenShell is available, authorized, and the profile is readable, then retry this command.",
  );
}

/** Ensure the endpointless profile required by OpenShell static credential binding. */
export async function ensureMcpBridgeProviderProfile(
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<void> {
  const boundary = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  await ensureOpenAiGatewayProviderProfile(runtimeSelection, boundary.adapter);
  const result = await boundary.adapter.importProviderProfile({
    profilePath: endpointlessProviderProfilePath(REPOSITORY_ROOT, MCP_BRIDGE_PROVIDER_TYPE),
    target: boundary.target,
  });
  if (result.ok) return;
  throw new McpBridgeError(
    result.error.kind === "command" && result.error.reason === "profile_incompatible"
      ? `OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless credential contract. Refusing to attach MCP credentials to it.`
      : result.operation === "import"
        ? `Could not import OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}'.`
        : `OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}' could not be exported for validation. Refusing to attach MCP credentials to it.`,
  );
}

export async function upsertMcpProvider(
  providerName: string,
  env: readonly ParsedEnvReference[],
  options: {
    allowExisting: boolean;
    expectedProviderId?: string;
    requireExisting?: boolean;
    prepareMutation?: (action: "create" | "update") => void | Promise<void>;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
    providerAdapter?: OpenShellProviderAdapter;
  },
): Promise<{
  action: "created" | "updated" | "reused" | "none";
  inspection: McpProviderInspection;
}> {
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
  const boundary = createMcpProviderAdapterBoundary(
    options.runtimeSelection,
    options.providerAdapter,
  );
  const inspection = await inspectMcpProvider(
    providerName,
    options.runtimeSelection,
    boundary.adapter,
  );
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${providerName}'.`,
    );
  }
  if (inspection.exists === false && options.requireExisting) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' disappeared before credential republish. Refusing to create a replacement with a different identity.`,
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
  await options.prepareMutation?.(action);
  // invalidState: another OpenShell client replaces a mutable provider name
  // between inspection and mutation. sourceBoundary: OpenShell owns provider
  // compare-and-swap; v0.0.99 uses the version read inside the server but its
  // update CLI exposes no caller-supplied expected version. whyNotSourceFix:
  // NemoClaw cannot bind its preinspection to the upstream atomic mutation, so
  // it uses randomized names, a lifecycle mutex, and immutable-ID/resource-version
  // reinspection.
  // regressionTest: mcp-provider-ownership.test.ts simulates a concurrent
  // resource-version writer and requires the ambiguous update to fail closed.
  // removalCondition: use native immutable provider IDs or caller-supplied CAS
  // once OpenShell exposes them, then remove this inspect-mutate-inspect
  // compensation.
  const beforeMutation = await inspectMcpProvider(
    providerName,
    options.runtimeSelection,
    boundary.adapter,
  );
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
  const credentials = env.flatMap((entry) => {
    validateMcpCredentialEnvName(entry.name);
    const value = envValues[entry.name];
    return value ? [{ name: entry.name, value }] : [];
  });
  const result =
    action === "create"
      ? await boundary.adapter.createProvider({
          name: providerName,
          type: MCP_BRIDGE_PROVIDER_TYPE,
          credentials,
          config: [],
          fromExisting: false,
          target: boundary.target,
        })
      : await boundary.adapter.updateProvider({
          providerName,
          credentials,
          config: [],
          target: boundary.target,
        });
  if (!result.ok) {
    // Never infer that our update committed from a later resource-version
    // increase: a concurrent writer can advance the same provider after our
    // command failed. A non-zero result is ambiguous and must fail closed.
    throw new McpBridgeError(
      result.error.message || `Failed to ${action} MCP provider '${providerName}'.`,
    );
  }
  const after = await inspectMcpProvider(providerName, options.runtimeSelection, boundary.adapter);
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

/**
 * Republish an attached provider after its endpointless credential binding is
 * active. OpenShell's Docker sidecar can observe the provider mutation before
 * the bound policy generation; a no-field update advances the provider
 * revision without reading or rotating the stored credential, giving the
 * sidecar a post-policy generation to synchronize.
 */
export async function refreshMcpProviderEnvironment(
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<McpProviderInspection> {
  assertPersistedAuthenticatedBridgeEntry(entry);
  if (!entry.providerName || !entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider identity for credential synchronization.`,
    );
  }
  const boundary = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const before = await inspectMcpProvider(entry.providerName, runtimeSelection, boundary.adapter);
  if (!providerMatchesCredential(before, entry.env[0], entry.providerId)) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' changed before credential synchronization. ${providerShapeDetail(before, entry.env[0], entry.providerId)} Refusing to mutate it.`,
    );
  }
  const result = await boundary.adapter.updateProvider({
    providerName: entry.providerName,
    credentials: [],
    config: [],
    target: boundary.target,
  });
  if (!result.ok) {
    throw new McpBridgeError(
      result.error.message ||
        `Failed to synchronize MCP provider '${entry.providerName}' after policy binding.`,
    );
  }
  const after = await inspectMcpProvider(entry.providerName, runtimeSelection, boundary.adapter);
  if (
    !providerMatchesCredential(after, entry.env[0], entry.providerId) ||
    !after.resourceVersion ||
    after.resourceVersion <= (before.resourceVersion ?? 0)
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' changed during credential synchronization. ${providerShapeDetail(after, entry.env[0], entry.providerId)} Refusing later MCP side effects.`,
    );
  }
  return after;
}

async function inspectMcpProviderForDeletion(
  entry: McpBridgeEntry,
  options: {
    allowLegacyGeneric?: boolean;
    allowMissing?: boolean;
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
    providerAdapter?: OpenShellProviderAdapter;
  },
): Promise<McpProviderInspection | null> {
  if (!entry.providerName) return null;
  try {
    assertPersistedAuthenticatedBridgeEntry(entry);
    if (!entry.providerId) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to delete same-name provider '${entry.providerName}'.`,
      );
    }
    const inspection = await inspectMcpProvider(
      entry.providerName,
      options.runtimeSelection,
      options.providerAdapter,
    );
    if (inspection.exists === false) {
      if (options.allowMissing) return inspection;
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' disappeared before delete.`,
      );
    }
    if (
      !providerMatchesManagedCredential(inspection, entry.env[0], entry.providerId, {
        allowLegacyGeneric: options.allowLegacyGeneric,
      })
    ) {
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

export async function deleteProvider(
  entry: McpBridgeEntry,
  options: {
    allowLegacyGeneric?: boolean;
    allowMissing?: boolean;
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
    providerAdapter?: OpenShellProviderAdapter;
  },
): Promise<void> {
  if (!entry.providerName) return;
  const boundary = createMcpProviderAdapterBoundary(
    options.runtimeSelection,
    options.providerAdapter,
  );
  const inspection = await inspectMcpProviderForDeletion(entry, {
    ...options,
    providerAdapter: boundary.adapter,
  });
  if (!inspection?.exists || !inspection.id || !inspection.resourceVersion) return;
  const result = await boundary.adapter.deleteProvider({
    providerName: entry.providerName,
    target: boundary.target,
  });
  if (!result.ok) {
    if (
      options.allowMissing &&
      result.error.kind === "command" &&
      result.error.reason === "not_found"
    )
      return;
    if (options.bestEffort) return;
    throw new McpBridgeError(
      result.error.message || `Failed to delete MCP provider '${entry.providerName}'.`,
    );
  }
  const after = await inspectMcpProvider(
    entry.providerName,
    options.runtimeSelection,
    boundary.adapter,
  );
  if (after.exists !== false && !options.bestEffort) {
    throw new McpBridgeError(
      after.error ?? `OpenShell provider '${entry.providerName}' still exists after delete.`,
    );
  }
}
