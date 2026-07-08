// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { addMcpBridge as addMcpBridgeLifecycle } from "./mcp-bridge-add-restart";
import {
  type McpBridgeAddOptions,
  McpBridgeError,
  type McpBridgeStatus,
} from "./mcp-bridge-contracts";
import {
  finalizeMcpBridgesAfterSandboxDelete as finalizeMcpBridgesAfterSandboxDeleteLifecycle,
  prepareMcpBridgesForAbsentSandboxDestroy as prepareMcpBridgesForAbsentSandboxDestroyLifecycle,
  prepareMcpBridgesForDestroy as prepareMcpBridgesForDestroyLifecycle,
  restoreMcpBridgesAfterDestroyAbort as restoreMcpBridgesAfterDestroyAbortLifecycle,
} from "./mcp-bridge-destroy";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import {
  prepareMcpBridgesForAbsentSandboxRebuild as prepareMcpBridgesForAbsentSandboxRebuildLifecycle,
  prepareMcpBridgesForRebuild as prepareMcpBridgesForRebuildLifecycle,
  reattachMcpProvidersAfterRebuildAbort as reattachMcpProvidersAfterRebuildAbortLifecycle,
  restoreMcpBridgesAfterRebuild as restoreMcpBridgesAfterRebuildLifecycle,
} from "./mcp-bridge-rebuild";
import { removeMcpBridge as removeMcpBridgeLifecycle } from "./mcp-bridge-remove";
import { renderMcpBridgeList, renderMcpBridgeStatus } from "./mcp-bridge-render";
import { credentialResolutionWarning } from "./mcp-bridge-resolution-probe";
import { restartMcpBridge as restartMcpBridgeLifecycle } from "./mcp-bridge-restart";
import { getSandboxAgent, getSandboxOrThrow } from "./mcp-bridge-state";
import { buildJsonSummary, statusMcpBridge } from "./mcp-bridge-status";
import { parseMcpAddArgs } from "./mcp-bridge-validation";

export {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
  buildOpenClawMcporterInspectCommand,
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  MCPORTER_VERSION,
  mcporterHeadersMatchExpected,
  parseAdapterRegistrationInspection,
} from "./mcp-bridge-adapters";
export type {
  McpBridgeAddOptions,
  McpBridgeStatus,
  ParsedEnvReference,
  ParsedMcpAddArgs,
} from "./mcp-bridge-contracts";
export { MCP_BRIDGE_POLICY_SOURCE, McpBridgeError } from "./mcp-bridge-contracts";
export {
  redactBridgeSecretsForDisplay,
  redactCredentialValuesForDisplay,
} from "./mcp-bridge-output";
export {
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy";
export {
  buildMcpBridgeProviderArgs,
  buildMcpCredentialRevisionObservationCommand,
  detachMissingProviderReference,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  providerDetachChangedState,
} from "./mcp-bridge-provider";
export {
  buildMcpBridgeProviderName,
  MCP_SERVER_URL_MAX_LENGTH,
  normalizeMcpServerUrl,
  parseMcpAddArgs,
  resolveCredentialEnv,
  validateMcpCredentialEnvName,
  validateMcpServerName,
} from "./mcp-bridge-validation";
export { statusMcpBridge };

export interface McpDestroyPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
  /** True when phase one was completed by an earlier destroy process. */
  destroyAlreadyPrepared: boolean;
  /** True when a previous destroy already confirmed the sandbox was absent. */
  destroyAlreadyPending: boolean;
}

export interface McpRebuildPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpBridgeEntry[];
}

export async function addMcpBridge(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<void> {
  return addMcpBridgeLifecycle(sandboxName, options);
}

export async function restartMcpBridge(sandboxName: string, server?: string): Promise<void> {
  return restartMcpBridgeLifecycle(sandboxName, server);
}

export async function removeMcpBridge(
  sandboxName: string,
  server: string,
  options: { force?: boolean; allowResidual?: boolean } = {},
): Promise<void> {
  return removeMcpBridgeLifecycle(sandboxName, server, options);
}

export async function prepareMcpBridgesForAbsentSandboxDestroy(
  sandboxName: string,
  options: { force?: boolean } = {},
): Promise<McpDestroyPreparation> {
  return prepareMcpBridgesForAbsentSandboxDestroyLifecycle(sandboxName, options);
}

export async function prepareMcpBridgesForDestroy(
  sandboxName: string,
): Promise<McpDestroyPreparation> {
  return prepareMcpBridgesForDestroyLifecycle(sandboxName);
}

export async function restoreMcpBridgesAfterDestroyAbort(
  sandboxName: string,
  preparation: McpDestroyPreparation,
): Promise<void> {
  return restoreMcpBridgesAfterDestroyAbortLifecycle(sandboxName, preparation);
}

export async function finalizeMcpBridgesAfterSandboxDelete(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  options: { force?: boolean } = {},
): Promise<void> {
  return finalizeMcpBridgesAfterSandboxDeleteLifecycle(sandboxName, preparation, options);
}

export async function prepareMcpBridgesForAbsentSandboxRebuild(
  sandboxName: string,
): Promise<McpRebuildPreparation> {
  return prepareMcpBridgesForAbsentSandboxRebuildLifecycle(sandboxName);
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
): Promise<McpRebuildPreparation> {
  return prepareMcpBridgesForRebuildLifecycle(sandboxName);
}

export async function reattachMcpProvidersAfterRebuildAbort(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  scrubbedAdapterEntries: readonly McpBridgeEntry[] = [],
): Promise<void> {
  return reattachMcpProvidersAfterRebuildAbortLifecycle(
    sandboxName,
    entries,
    scrubbedAdapterEntries,
  );
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
): Promise<void> {
  return restoreMcpBridgesAfterRebuildLifecycle(sandboxName, entries);
}

function parseJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  return {
    json: args.includes("--json"),
    rest: args.filter((arg) => arg !== "--json"),
  };
}

function parseProbeFlags(args: string[]): { probe?: boolean; rest: string[] } {
  if (args.includes("--probe") && args.includes("--no-probe")) {
    throw new McpBridgeError("Pass at most one of --probe / --no-probe.", 2);
  }
  const probe = args.includes("--probe") ? true : args.includes("--no-probe") ? false : undefined;
  return { probe, rest: args.filter((arg) => arg !== "--probe" && arg !== "--no-probe") };
}

/**
 * Post-add wire probe (#6379). Reports only — the add transaction committed
 * durably and a resolution failure is a host-side OpenShell defect, so a
 * nonzero exit here would break scripted adds mid-remediation; `mcp status
 * <server>` remains the authoritative recheck.
 */
async function reportAddCredentialResolution(sandboxName: string, server: string): Promise<void> {
  let probe: McpBridgeStatus["provider"]["credentialResolution"];
  let credentialEnvName: string | undefined;
  try {
    const [status] = await statusMcpBridge(sandboxName, server, {
      probeCredentialResolution: true,
    });
    probe = status?.provider.credentialResolution;
    credentialEnvName = status?.env.names[0];
  } catch {
    console.log(
      "  Credential resolution probe was inconclusive: post-add readiness inspection failed; run mcp status for this server to retry.",
    );
    return;
  }
  if (!probe) {
    console.log("  Credential resolution probe was inconclusive: post-add status unavailable.");
    return;
  }
  const warning = credentialResolutionWarning(credentialEnvName, probe);
  if (probe.ok === true) {
    console.log(
      `  Credential resolution verified on the wire (HTTP ${probe.httpStatus})${probe.detail ? `: ${probe.detail}` : "."}`,
    );
  } else if (warning) {
    console.error(`  WARNING: ${warning}`);
  } else {
    console.log(
      `  Credential resolution probe was inconclusive${probe.detail ? `: ${probe.detail}` : "."}`,
    );
  }
}

function requireNoExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new McpBridgeError(usage, 2);
}

function requireAtMostOneArg(args: string[], usage: string): string | undefined {
  if (args.length > 1) throw new McpBridgeError(usage, 2);
  return args[0];
}

function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function renderMcpHelp(subcommand: string): void {
  switch (subcommand) {
    case "add":
      console.log(`USAGE
  nemoclaw <name> mcp add <server> --url <https-mcp-url> --env KEY

FLAGS
  --url URL        MCP Streamable HTTP endpoint
  --env KEY        Required host credential reference registered with OpenShell
  --no-probe       Skip the post-add wire-level credential-resolution probe

SECURITY
  Credentials are registered as an OpenShell provider and appear inside the
  sandbox only as openshell:resolve:env:KEY placeholders. OpenShell resolves
  them at egress while enforcing the generated protocol: mcp policy.`);
      return;
    case "list":
      console.log(`USAGE
  nemoclaw <name> mcp list [--json]

FLAGS
  --json  Emit sandbox, support, and MCP server state as JSON`);
      return;
    case "status":
      console.log(`USAGE
  nemoclaw <name> mcp status [server] [--json] [--probe|--no-probe]

FLAGS
  --json      Emit MCP server status as JSON
  --probe     Request the wire-level credential-resolution probe for every server
  --no-probe  Skip the probe (it defaults on only when a single server is named)`);
      return;
    case "restart":
      console.log(`USAGE
  nemoclaw <name> mcp restart [server]`);
      return;
    case "remove":
      console.log(`USAGE
  nemoclaw <name> mcp remove <server> [--force]

FLAGS
  --force  Best-effort owned cleanup; preserves registry state when residuals remain`);
      return;
    default:
      console.log(`USAGE
  nemoclaw <name> mcp <add|list|status|restart|remove> [args...]`);
  }
}

export async function dispatchMcpBridgeCommand(
  sandboxName: string,
  actionArgs: string[],
): Promise<void> {
  const [subcommand = "list", ...rest] = actionArgs;
  try {
    if (subcommand === "--help" || subcommand === "-h") {
      renderMcpHelp("mcp");
      return;
    }
    if (hasHelpFlag(rest)) {
      renderMcpHelp(subcommand);
      return;
    }
    switch (subcommand) {
      case "add": {
        const { probe, rest: addRest } = parseProbeFlags(rest);
        if (probe === true)
          throw new McpBridgeError(
            "Usage: nemoclaw <sandbox> mcp add <server> --url <https-mcp-url> --env KEY [--no-probe]",
            2,
          );
        const options = parseMcpAddArgs(addRest);
        await addMcpBridge(sandboxName, options);
        console.log(`  MCP server '${options.server}' added to sandbox '${sandboxName}'.`);
        if (probe !== false) await reportAddCredentialResolution(sandboxName, options.server);
        return;
      }
      case "list": {
        const { json, rest: listRest } = parseJsonFlag(rest);
        requireNoExtraArgs(listRest, "Usage: nemoclaw <sandbox> mcp list [--json]");
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName);
        if (json)
          console.log(JSON.stringify(buildJsonSummary(sandboxName, agent, statuses), null, 2));
        else renderMcpBridgeList(sandboxName, statuses, agent);
        return;
      }
      case "status": {
        const { json, rest: statusJsonRest } = parseJsonFlag(rest);
        const { probe, rest: statusRest } = parseProbeFlags(statusJsonRest);
        const server = requireAtMostOneArg(
          statusRest,
          "Usage: nemoclaw <sandbox> mcp status [server] [--json] [--probe|--no-probe]",
        );
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName, server, {
          probeCredentialResolution: probe ?? server !== undefined,
        });
        if (json) {
          console.log(
            JSON.stringify(
              server ? statuses[0] : buildJsonSummary(sandboxName, agent, statuses),
              null,
              2,
            ),
          );
        } else renderMcpBridgeStatus(sandboxName, statuses, agent);
        return;
      }
      case "restart": {
        const server = requireAtMostOneArg(rest, "Usage: nemoclaw <sandbox> mcp restart [server]");
        await restartMcpBridge(sandboxName, server);
        return;
      }
      case "remove": {
        const force = rest.includes("--force");
        const names = rest.filter((arg) => arg !== "--force");
        const server = names[0];
        if (!server || names.length > 1)
          throw new McpBridgeError("Usage: nemoclaw <sandbox> mcp remove <server> [--force]", 2);
        await removeMcpBridge(sandboxName, server, { force });
        return;
      }
      default:
        throw new McpBridgeError(
          "Usage: nemoclaw <sandbox> mcp <add|list|status|restart|remove> [args...]",
          2,
        );
    }
  } catch (error) {
    if (error instanceof McpBridgeError) {
      console.error(`  ${redactBridgeSecretsForDisplay(error.message)}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}
