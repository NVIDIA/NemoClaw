// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  assertAgentMcpTeardownRuntimeCapability,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import {
  assertGeneratedPolicyMutationSafe,
  getPolicyPresence,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import {
  detachProvider,
  inspectMcpProvider,
  providerMatchesManagedCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  resolveMcpOperationTarget,
} from "./mcp-bridge-state";
import { inspectSourceBridgeState } from "./mcp-bridge-source";
import {
  resolvePersistedCredentialEnvForRedaction,
  validateMcpServerName,
  validateSandboxName,
} from "./mcp-bridge-validation";

export async function removeMcpBridge(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  return withMcpLifecycleLock(sandboxName, async () => {
    assertHermesPortableCommandUnavailable(sandboxName, "sandbox:mcp:remove");
    validateSandboxName(sandboxName);
    validateMcpServerName(server);
    const target = resolveMcpOperationTarget(sandboxName);
    const { sandbox, runtimeSelection } = target;
    const operationTarget = target.liveIdentity ? target : undefined;
    const observed = await inspectSourceBridgeState(
      sandbox,
      runtimeSelection,
      ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
    );
    if (Object.keys(observed.sources.legacy).length > 0) {
      throw new McpBridgeError(
        `Legacy MCP agent configuration requires explicit migration. Run \`nemoclaw ${sandboxName} mcp migrate\` first.`,
        2,
      );
    }
    const entry = observed.bridges[server];
    if (!entry) {
      if (!options.force) {
        throw new McpBridgeError(
          `MCP server '${server}' was not found in the ${getSandboxAgent(sandbox).displayName} configuration.`,
        );
      }
      console.log(`  No native MCP server '${server}' is configured on sandbox '${sandboxName}'.`);
      return;
    }

    assertGeneratedPolicyMutationSafe(sandboxName, entry);
    await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
    const adapter = isAgentMcpAdapter(entry.adapter)
      ? entry.adapter
      : getBridgeAdapter(getSandboxAgent(sandbox));

    assertAgentMcpTeardownRuntimeCapability(sandboxName, adapter, runtimeSelection);
    const envValues = resolvePersistedCredentialEnvForRedaction(entry.env);
    let preservedProvider: string | undefined;
    try {
      const policyPresent = getPolicyPresence(
        sandboxName,
        entry,
        runtimeSelection,
        ...(operationTarget ? ([operationTarget] as const) : ([] as const)),
      );
      if (policyPresent === null) {
        throw new McpBridgeError("Could not prove the current generated MCP policy state.");
      }
      // The live policy binds the provider identity. Keep that binding until
      // detach is proven; a retry after policy removal must not adopt the
      // default same-name provider inferred by source inspection.
      if (policyPresent && entry.providerName) {
        const provider = await inspectMcpProvider(entry.providerName, runtimeSelection);
        const exact =
          !!entry.providerId &&
          providerMatchesManagedCredential(provider, entry.env[0], entry.providerId, {
            allowLegacyGeneric: true,
          });
        if (exact) {
          operationTarget?.liveIdentity?.assertCurrent();
          const outcome = await detachProvider(sandboxName, entry, {
            allowLegacyGeneric: true,
            runtimeSelection,
          });
          if (outcome === "unknown") {
            throw new McpBridgeError(
              `Provider detach state for '${entry.providerName}' is unknown.`,
            );
          }
        } else if (provider.exists !== false) {
          throw new McpBridgeError(
            `Provider '${entry.providerName}' could not be proven as the current exact MCP provider and was preserved.`,
          );
        }
        if (provider.exists !== false) preservedProvider = entry.providerName;
      }
      if (entry.env.length > 0) {
        // Fresh exec credential absence is required even if the provider or
        // policy was already absent and conveyed no detach authority.
        waitForDetachedMcpCredential(sandboxName, entry, runtimeSelection);
      }
      if (policyPresent)
        removeGeneratedPolicy(sandboxName, entry, {
          runtimeSelection,
          ...(operationTarget ? { operationTarget } : {}),
        });
    } catch (error) {
      const detail = redactBridgeSecretsForDisplay(
        error instanceof Error ? error.message : String(error),
        entry,
        envValues,
      );
      throw new McpBridgeError(
        `MCP cleanup is incomplete; the native server '${server}' was retained. Fix the reported cause and rerun \`nemoclaw ${sandboxName} mcp remove ${server}\`.${detail ? ` ${detail}` : ""}`,
      );
    }

    const removal = unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
      force: options.force === true,
      envValues,
      teardown: true,
      ...(operationTarget ? { operationTarget } : {}),
    });
    if (removal === "unowned" && !options.force) {
      throw new McpBridgeError(
        `The native MCP server '${server}' changed before removal. Rerun against the current agent configuration.`,
      );
    }
    if (preservedProvider) {
      console.warn(
        `  Preserved OpenShell provider '${preservedProvider}'. Remove it explicitly after confirming no sandbox uses it.`,
      );
    }

    console.log(
      `  Removed MCP server '${server}' from the agent configuration on '${sandboxName}'.`,
    );
  });
}
