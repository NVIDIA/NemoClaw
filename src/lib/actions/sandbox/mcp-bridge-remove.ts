// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  assertAgentMcpTeardownRuntimeCapability,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import { removeGeneratedPolicy } from "./mcp-bridge-policy";
import {
  detachProvider,
  getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider,
  providerMatchesManagedCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import {
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
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
    const sandbox = getSandboxOrThrow(sandboxName);
    const runtimeSelection = getMcpProviderInspectionRuntimeSelection(sandbox);
    const observed = inspectSourceBridgeState(sandbox, runtimeSelection);
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

    await ensureSandboxGatewaySelected(sandboxName, runtimeSelection);
    const adapter = isAgentMcpAdapter(entry.adapter)
      ? entry.adapter
      : getBridgeAdapter(getSandboxAgent(sandbox));

    assertAgentMcpTeardownRuntimeCapability(sandboxName, adapter, runtimeSelection);
    const removal = unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
      force: options.force === true,
      envValues: resolvePersistedCredentialEnvForRedaction(entry.env),
      teardown: true,
    });
    if (removal === "unowned" && !options.force) {
      throw new McpBridgeError(
        `The native MCP server '${server}' changed before removal. Rerun against the current agent configuration.`,
      );
    }

    const warnings: string[] = [];
    try {
      removeGeneratedPolicy(sandboxName, entry, { runtimeSelection });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }

    if (entry.providerName) {
      const provider = inspectMcpProvider(entry.providerName, runtimeSelection);
      const exact =
        !!entry.providerId &&
        providerMatchesManagedCredential(provider, entry.env[0], entry.providerId, {
          allowLegacyGeneric: true,
        });
      if (exact) {
        try {
          const outcome = detachProvider(sandboxName, entry, {
            allowLegacyGeneric: true,
            runtimeSelection,
          });
          if (outcome === "unknown") {
            warnings.push(`Provider detach state for '${entry.providerName}' is unknown.`);
          } else {
            waitForDetachedMcpCredential(sandboxName, entry, runtimeSelection);
          }
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      } else if (provider.exists !== false) {
        warnings.push(
          `Provider '${entry.providerName}' could not be proven as the current exact MCP provider and was preserved.`,
        );
      }
      if (provider.exists !== false) {
        console.warn(
          `  Preserved OpenShell provider '${entry.providerName}'. Remove it explicitly after confirming no sandbox uses it.`,
        );
      }
    }

    console.log(`  Removed MCP server '${server}' from the agent configuration on '${sandboxName}'.`);
    for (const warning of warnings) console.warn(`  MCP cleanup warning: ${warning}`);
    if (warnings.length > 0 && !options.allowResidual && !options.force) {
      throw new McpBridgeError(
        `The agent registration was removed, but ${String(warnings.length)} conservative cleanup warning(s) remain.`,
      );
    }
  });
}
