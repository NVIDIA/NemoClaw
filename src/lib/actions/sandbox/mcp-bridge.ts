// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { McpScrubbedAdapterEntry } from "./mcp-bridge-adapter-teardown";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider";
import { addMcpBridge as addMcpBridgeLifecycle } from "./mcp-bridge-add-restart";
import {
  type McpBridgeAddOptions,
  McpBridgeError,
  type McpBridgeStatus,
} from "./mcp-bridge-contracts";
import {
  finalizeMcpBridgesAfterSandboxDelete as finalizeMcpBridgesAfterSandboxDeleteLifecycle,
  prepareMcpBridgesForAbsentSandboxDestroy as prepareMcpBridgesForAbsentSandboxDestroyLifecycle,
  restoreMcpBridgesAfterDestroyAbort as restoreMcpBridgesAfterDestroyAbortLifecycle,
} from "./mcp-bridge-destroy";
import type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import {
  type McpRebuildPreparation,
  prepareMcpBridgesForAbsentSandboxRebuild as prepareMcpBridgesForAbsentSandboxRebuildLifecycle,
  prepareMcpBridgesForRebuild as prepareMcpBridgesForRebuildLifecycle,
  reattachMcpProvidersAfterRebuildAbort as reattachMcpProvidersAfterRebuildAbortLifecycle,
  restoreMcpBridgesAfterRebuild as restoreMcpBridgesAfterRebuildLifecycle,
} from "./mcp-bridge-rebuild";
import { removeMcpBridge as removeMcpBridgeLifecycle } from "./mcp-bridge-remove";
import { migrateMcpBridges } from "./mcp-bridge-migration";
import { renderMcpBridgeList, renderMcpBridgeStatus } from "./mcp-bridge-render";
import { credentialResolutionWarning } from "./mcp-bridge-resolution-probe";
import { restartMcpBridge as restartMcpBridgeLifecycle } from "./mcp-bridge-restart";
import { getMcpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider";
import { inspectSourceBridgeState, joinMcpEntriesToOpenShell } from "./mcp-bridge-source";
import { getSandboxAgent, getSandboxOrThrow, hydrateBridgeState } from "./mcp-bridge-state";
import { buildJsonSummary, statusMcpBridge } from "./mcp-bridge-status";
import { parseMcpAddArgs } from "./mcp-bridge-validation";
import { clearTransientBridgeState } from "./mcp-bridge/transient-state";

export {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
  buildOpenClawMcpInspectCommand,
  buildOpenClawMcpRegisterCommand,
  buildOpenClawMcpRemoveCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  MCPORTER_VERSION,
  openClawHeadersMatchExpected,
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
export type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
export type { McpRebuildPreparation };
export { statusMcpBridge };

export function resetMcpBridgeTransientStateForTest(): void {
  clearTransientBridgeState();
}

function hydrateCurrentBridgeState(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
  options: { allowLegacyHandoff?: boolean } = {},
): McpProviderInspectionRuntimeSelection {
  const sandbox = getSandboxOrThrow(sandboxName);
  const selected = runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox);
  const observed = inspectSourceBridgeState(sandbox, selected);
  const legacyNames = Object.keys(observed.sources.legacy).sort();
  if (legacyNames.length > 0 && !options.allowLegacyHandoff) {
    throw new McpBridgeError(
      `Legacy MCP agent configuration requires explicit migration for '${legacyNames.join(", ")}'. Run \`nemoclaw ${sandboxName} mcp migrate\` to preview it.`,
      2,
    );
  }
  const bridges = options.allowLegacyHandoff
    ? {
        ...joinMcpEntriesToOpenShell(
          sandbox,
          observed.sources.legacy,
          selected,
          "inspect legacy MCP migration state",
        ),
        ...observed.bridges,
      }
    : observed.bridges;
  hydrateBridgeState(sandboxName, bridges);
  return selected;
}

export async function addMcpBridge(
  sandboxName: string,
  options: McpBridgeAddOptions,
): Promise<McpProviderInspectionRuntimeSelection> {
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
  options: {
    force?: boolean;
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
  } = {},
): Promise<McpDestroyPreparation> {
  return prepareMcpBridgesForAbsentSandboxDestroyLifecycle(sandboxName, options);
}

export async function prepareMcpBridgesForDestroy(
  sandboxName: string,
  options: {
    force?: boolean;
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
  } = {},
): Promise<McpDestroyPreparation> {
  void sandboxName;
  return {
    entries: [],
    ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
  };
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
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<McpRebuildPreparation> {
  return prepareMcpBridgesForAbsentSandboxRebuildLifecycle(sandboxName, runtimeSelection);
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<McpRebuildPreparation> {
  hydrateCurrentBridgeState(sandboxName, runtimeSelection, { allowLegacyHandoff: true });
  return prepareMcpBridgesForRebuildLifecycle(sandboxName, runtimeSelection);
}

export async function reattachMcpProvidersAfterRebuildAbort(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  scrubbedAdapterEntries: readonly McpScrubbedAdapterEntry[] = [],
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  return reattachMcpProvidersAfterRebuildAbortLifecycle(
    sandboxName,
    entries,
    scrubbedAdapterEntries,
    runtimeSelection,
  );
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  return restoreMcpBridgesAfterRebuildLifecycle(sandboxName, entries, runtimeSelection);
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

function parseToolsFlag(args: string[]): { tools: boolean; rest: string[] } {
  return {
    tools: args.includes("--tools"),
    rest: args.filter((arg) => arg !== "--tools"),
  };
}

/**
 * Post-add wire probe (#6379). Reports only — the add transaction committed
 * durably and a resolution failure is a host-side OpenShell defect, so a
 * nonzero exit here would break scripted adds mid-remediation; `mcp status
 * <server>` remains the authoritative recheck.
 */
async function reportAddCredentialResolution(
  sandboxName: string,
  server: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  let probe: McpBridgeStatus["provider"]["credentialResolution"];
  let credentialEnvName: string | undefined;
  try {
    const [status] = await statusMcpBridge(sandboxName, server, {
      probeCredentialResolution: true,
      runtimeSelection,
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
  nemoclaw <name> mcp add <server> --url <https-mcp-url> --env KEY [--trusted-private-host HOST]

FLAGS
  --url URL        MCP Streamable HTTP endpoint
  --env KEY        Required host credential reference registered with OpenShell
  --trusted-private-host HOST
                   Trust the exact URL host when it resolves only to routed private addresses
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
  nemoclaw <name> mcp status [server] [--json] [--probe|--no-probe] [--tools]

FLAGS
  --json      Emit MCP server status as JSON
  --probe     Request the wire-level credential-resolution probe for every server
  --no-probe  Skip the probe (it defaults on only when a single server is named)
  --tools     Discover names advertised by one named MCP server`);
      return;
    case "restart":
      console.log(`USAGE
  nemoclaw <name> mcp restart [server]`);
      return;
    case "remove":
      console.log(`USAGE
  nemoclaw <name> mcp remove <server> [--force]

FLAGS
  --force  Best-effort source cleanup; preserves ambiguous providers`);
      return;
    case "migrate":
      console.log(`USAGE
  nemoclaw <name> mcp migrate [--apply] [--json]

FLAGS
  --apply  Atomically materialize legacy entries in agent-native configuration
  --json   Emit the secret-free migration plan as JSON`);
      return;
    default:
      console.log(`USAGE
  nemoclaw <name> mcp <add|list|status|restart|remove|migrate> [args...]`);
  }
}

export async function dispatchMcpBridgeCommand(
  sandboxName: string,
  actionArgs: string[],
  dependencies: { rebuildForMigration?: (sandboxName: string) => Promise<void> } = {},
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
            "Usage: nemoclaw <sandbox> mcp add <server> --url <https-mcp-url> --env KEY [--trusted-private-host HOST] [--no-probe]",
            2,
          );
        const options = parseMcpAddArgs(addRest);
        const runtimeSelection = await addMcpBridge(sandboxName, options);
        console.log(`  MCP server '${options.server}' added to sandbox '${sandboxName}'.`);
        if (probe !== false) {
          await reportAddCredentialResolution(sandboxName, options.server, runtimeSelection);
        }
        return;
      }
      case "list": {
        const { json, rest: listRest } = parseJsonFlag(rest);
        requireNoExtraArgs(listRest, "Usage: nemoclaw <sandbox> mcp list [--json]");
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName);
        if (json)
          process.stdout.write(`${JSON.stringify(buildJsonSummary(sandboxName, agent, statuses), null, 2)}\n`);
        else renderMcpBridgeList(sandboxName, statuses, agent);
        return;
      }
      case "status": {
        const { json, rest: statusJsonRest } = parseJsonFlag(rest);
        const { tools, rest: statusToolsRest } = parseToolsFlag(statusJsonRest);
        const { probe, rest: statusRest } = parseProbeFlags(statusToolsRest);
        const server = requireAtMostOneArg(
          statusRest,
          "Usage: nemoclaw <sandbox> mcp status [server] [--json] [--probe|--no-probe] [--tools]",
        );
        if (tools && server === undefined) {
          throw new McpBridgeError("Pass one MCP server name with --tools.", 2);
        }
        const sandbox = getSandboxOrThrow(sandboxName);
        const agent = getSandboxAgent(sandbox);
        const statuses = await statusMcpBridge(sandboxName, server, {
          probeCredentialResolution: probe === true || (probe !== false && !tools && !!server),
          discoverTools: tools,
        });
        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              server ? statuses[0] : buildJsonSummary(sandboxName, agent, statuses),
              null,
              2,
            )}\n`,
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
      case "migrate": {
        const apply = rest.includes("--apply");
        const json = rest.includes("--json");
        const extra = rest.filter((arg) => arg !== "--apply" && arg !== "--json");
        requireNoExtraArgs(extra, "Usage: nemoclaw <sandbox> mcp migrate [--apply] [--json]");
        const plan = await migrateMcpBridges(sandboxName, {
          apply,
          rebuildSandbox: dependencies.rebuildForMigration,
        });
        if (json) {
          process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
          return;
        }
        if (plan.items.length === 0) {
          console.log(`  No legacy MCP agent configuration found on '${sandboxName}'.`);
          return;
        }
        for (const item of plan.items) {
          console.log(
            `  ${item.action === "migrate" ? "Migrate" : "Verify"} '${item.server}': legacy -> native (${item.url})`,
          );
          if (item.activationChanges) {
            console.log("    This activates an OpenClaw server that the legacy Mcporter adapter did not load.");
          }
        }
        console.log(
          plan.applied
            ? "  MCP migration completed and legacy registry fields were retired."
            : "  Preview only. Rerun with --apply to authorize native materialization.",
        );
        return;
      }
      default:
        throw new McpBridgeError(
          "Usage: nemoclaw <sandbox> mcp <add|list|status|restart|remove|migrate> [args...]",
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
