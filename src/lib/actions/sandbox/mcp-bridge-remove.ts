// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { McpBridgeEntry } from "../../state/registry";
import {
  assertAgentMcpMutationRuntimeCapability,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import { assertGeneratedPolicyMutationSafe, removeGeneratedPolicy } from "./mcp-bridge-policy";
import {
  deleteProvider,
  detachMissingProviderReference,
  detachProvider,
  inspectMcpProvider,
  providerMatchesCredential,
  providerShapeDetail,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  assertMcpDestroyNotPending,
  bridgeState,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
  removeBridgeEntry,
} from "./mcp-bridge-state";
import {
  assertAuthenticatedBridgeEntry,
  resolveCredentialEnv,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";

function assertExactMcpRemoveProvider(
  entry: McpBridgeEntry,
  options: { allowMissing: boolean; force?: boolean },
): void {
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing destructive cleanup of same-name provider '${entry.providerName}'. Remove the legacy bridge with --force only after independently cleaning that provider.`,
    );
  }
  const inspection = inspectMcpProvider(entry.providerName);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`,
    );
  }
  if (!inspection.exists) {
    if (options.allowMissing) return;
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is missing. Refusing to destroy sandbox state because a failed sandbox delete could not restore authenticated MCP without the preserved provider credential.`,
    );
  }
  if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
    const forceDetail = options.force
      ? " --force does not delete a non-matching global provider because it may be owned by another workflow."
      : "";
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' no longer exactly matches MCP server '${entry.server}'. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)}${forceDetail}`,
    );
  }
}

export async function removeMcpBridge(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, () =>
    removeMcpBridgeUnlocked(sandboxName, server, options),
  );
}

async function removeMcpBridgeUnlocked(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  validateSandboxName(sandboxName);
  validateMcpServerName(server);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(sandbox);
  const entry = bridgeState(sandbox)[server];
  if (!entry) {
    if (!options.force) {
      throw new McpBridgeError(`MCP server '${server}' not found on sandbox '${sandboxName}'.`);
    }
    console.log(`  No MCP server '${server}' is registered on sandbox '${sandboxName}'.`);
    return;
  }
  if (entry.addState === "prepared") {
    // `prepared` is persisted before gateway selection and is advanced only
    // after adapter/provider/policy absence has been proven. It therefore owns
    // no external resources and can be cancelled without touching same-name
    // state another workflow may own.
    removeBridgeEntry(sandboxName, server);
    console.log(`  Cancelled incomplete MCP add for '${server}' on sandbox '${sandboxName}'.`);
    return;
  }
  // Cleanup follows the adapter persisted with the bridge. Requiring the
  // sandbox's current agent to still advertise MCP support would strand old
  // resources after an agent/capability migration.
  const adapter = isAgentMcpAdapter(entry.adapter)
    ? entry.adapter
    : getBridgeAdapter(getSandboxAgent(sandbox));
  await ensureSandboxGatewaySelected(sandboxName);
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
  const failures: string[] = [];
  let providerOwnershipProved = !entry.providerName;
  let providerWasMissing = false;
  if (entry.providerName) {
    if (!entry.providerId) {
      const inspection = inspectMcpProvider(entry.providerName);
      if (inspection.exists === false) {
        // With no live provider there is no global object to adopt or destroy.
        // This lets an operator independently remove a legacy/orphan provider,
        // then use MCP remove to clear only the exact adapter/policy manifest.
        providerOwnershipProved = true;
        providerWasMissing = true;
      } else {
        const detail =
          inspection.exists === null
            ? (inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`)
            : `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to detach or delete same-name provider '${entry.providerName}'.`;
        if (!options.force) throw new McpBridgeError(detail);
        failures.push(detail);
      }
    } else {
      const inspection = inspectMcpProvider(entry.providerName);
      if (inspection.exists === false) {
        providerOwnershipProved = true;
        providerWasMissing = true;
      } else if (
        inspection.exists === true &&
        entry.env.length === 1 &&
        providerMatchesCredential(inspection, entry.env[0], entry.providerId)
      ) {
        providerOwnershipProved = true;
      } else {
        const detail =
          inspection.exists === null
            ? (inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`)
            : `OpenShell provider '${entry.providerName}' has drifted or lacks a complete registered credential binding. ${providerShapeDetail(inspection, entry.env[0], entry.providerId) ?? ""}`;
        if (!options.force) {
          throw new McpBridgeError(detail);
        }
        // Force is allowed to continue cleaning resources whose ownership is
        // independently provable, but it never broadens ownership of a global
        // provider merely because the local bridge registry names it.
        failures.push(detail);
      }
    }
  }

  let missingProviderReferenceDetached = false;
  if (providerWasMissing && providerOwnershipProved && entry.providerName) {
    try {
      detachMissingProviderReference(sandboxName, entry);
      missingProviderReferenceDetached = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }

  // A dangling provider name can prevent fresh sandbox execs on OpenShell
  // main, so clear that host-side spec reference before mutating the in-sandbox
  // adapter.
  assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);

  const adapterEnvValues = resolveCredentialEnv(entry.env.map((envName) => ({ name: envName })));
  let adapterCleanupProved = true;
  try {
    unregisterAgentAdapter(
      sandboxName,
      (entry.adapter as AgentMcpAdapter | undefined) ?? adapter,
      entry,
      { force: options.force === true, envValues: adapterEnvValues },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!options.force) throw new McpBridgeError(detail);
    adapterCleanupProved = false;
    failures.push(detail);
  }
  let reservationCleanupProved = !entry.providerName && adapterCleanupProved;
  if (adapterCleanupProved && providerOwnershipProved && entry.providerName) {
    try {
      // OpenShell main cannot list a sandbox whose spec references a missing
      // provider. Remove that dangling name directly before using the normal
      // table-backed detach path for a provider that still exists.
      const detachOutcome = providerWasMissing
        ? missingProviderReferenceDetached
          ? "detached"
          : "unknown"
        : detachProvider(sandboxName, entry);
      if (detachOutcome !== "unknown") {
        // A missing provider has no credential left to revoke. Its stock CLI
        // detach result is authoritative for the sandbox-spec reference, and
        // skipping a fresh-exec probe lets cleanup proceed even if another
        // unrelated provider reference is also dangling.
        if (!providerWasMissing) waitForDetachedMcpCredential(sandboxName, entry);
        reservationCleanupProved = true;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }
  if (reservationCleanupProved) {
    try {
      removeGeneratedPolicy(sandboxName, entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  } else {
    failures.push(
      `Provider detach state for '${entry.providerName}' is unknown; preserved the MCP policy and ownership manifest.`,
    );
  }
  if (
    reservationCleanupProved &&
    providerOwnershipProved &&
    !providerWasMissing &&
    entry.providerName
  ) {
    try {
      // Recheck immediately before the mutable-name delete to narrow the
      // replacement window. OpenShell main does not expose an atomic
      // identity-conditioned delete, so concurrent direct provider mutation
      // remains outside this lifecycle command's safety boundary.
      assertExactMcpRemoveProvider(entry, {
        allowMissing: false,
        force: options.force,
      });
      deleteProvider(entry, {
        allowMissing: options.force === true || entry.addState === "preflighted",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!options.force) throw new McpBridgeError(detail);
      failures.push(detail);
    }
  }
  if (failures.length > 0) {
    console.warn(`  MCP force cleanup warnings:\n${failures.join("\n")}`);
    if (!options.allowResidual) {
      throw new McpBridgeError(
        `MCP force cleanup left residual resources for '${server}'. The registry entry was preserved so cleanup can be retried.`,
      );
    }
    return;
  }
  removeBridgeEntry(sandboxName, server);
  console.log(`  Removed MCP server '${server}' from sandbox '${sandboxName}'.`);
}
