// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import { explicitObservabilityFlag } from "../../onboard/observability-command-flag";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForStoppedSandboxRebuild,
  prepareMcpBridgesForRebuild,
  reattachMcpProvidersAfterRebuildAbort,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge";
import type { RebuildBail } from "./rebuild-credential-preflight";
import { type RebuildSandboxEntry, resolveSandboxGatewayName } from "./rebuild-flow-helpers";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider";
import { getMcpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider";
import {
  assertNoLegacyMcpSources,
  inspectAgentMcpSources,
  inspectCapturedAgentMcpSources,
  joinMcpEntriesToOpenShell,
  type McpSourceObservationDeadline,
} from "./mcp-bridge-source";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { PreparedStoppedNativeState } from "../../state/state-directory-restore";

export type McpRebuildPreparation = Awaited<ReturnType<typeof prepareMcpBridgesForRebuild>>;

export async function observeMcpStateForRebuild(
  sandbox: RebuildSandboxEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection | undefined,
  inspectCurrentSource: boolean,
  deadline?: McpSourceObservationDeadline,
  stoppedNativeState?: PreparedStoppedNativeState,
): Promise<{
  entries: McpSourceEntry[];
  runtimeSelection?: McpProviderInspectionRuntimeSelection;
}> {
  if (!inspectCurrentSource) return { entries: [] };
  if (
    stoppedNativeState &&
    (stoppedNativeState.sandboxName !== sandbox.name ||
      stoppedNativeState.agentName !== (sandbox.agent ?? "openclaw"))
  )
    throw new Error("Captured MCP source does not match the rebuild target.");
  const sourceRuntime = runtimeSelection ?? {
    gatewayName: resolveSandboxGatewayName(sandbox),
    workspace: OPENSHELL_DEFAULT_WORKSPACE,
  };
  const sources = stoppedNativeState
    ? inspectCapturedAgentMcpSources(stoppedNativeState)
    : await inspectAgentMcpSources(sandbox, sourceRuntime, deadline);
  assertNoLegacyMcpSources(sandbox.name, sources.legacy, "rebuilding");
  if (Object.keys(sources.native).length === 0) return { entries: [] };
  const selectedRuntime = runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox);
  const entries = Object.values(
    await joinMcpEntriesToOpenShell(
      sandbox,
      sources.native,
      selectedRuntime,
      "inspect current MCP source state",
      deadline,
    ),
  );
  return {
    entries,
    ...(entries.length > 0 ? { runtimeSelection: selectedRuntime } : {}),
  };
}

export async function prepareMcpForRebuild(
  sandboxName: string,
  staleRecovery: boolean,
  bail: RebuildBail,
  frozenRuntimeSelection?: McpProviderInspectionRuntimeSelection,
  sourceEntries: readonly McpSourceEntry[] = [],
  stoppedNativeState?: PreparedStoppedNativeState,
): Promise<McpRebuildPreparation | null> {
  // Source inspection resolves OpenShell authority lazily only after it finds
  // MCP intent. A retained recovery handoff is the sole eager authority input.
  const runtimeSelection = frozenRuntimeSelection;
  try {
    if (stoppedNativeState)
      return await prepareMcpBridgesForStoppedSandboxRebuild(
        sandboxName,
        sourceEntries,
        stoppedNativeState,
        runtimeSelection,
      );
    return await (staleRecovery
      ? runtimeSelection
        ? prepareMcpBridgesForAbsentSandboxRebuild(sandboxName, runtimeSelection, sourceEntries)
        : prepareMcpBridgesForAbsentSandboxRebuild(sandboxName, undefined, sourceEntries)
      : runtimeSelection
        ? prepareMcpBridgesForRebuild(sandboxName, runtimeSelection, sourceEntries)
        : prepareMcpBridgesForRebuild(sandboxName, undefined, sourceEntries));
  } catch (error) {
    bail(
      `Failed to preserve MCP bridges before rebuild: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function reattachMcpAfterDeleteFailure(
  sandboxName: string,
  entries: McpRebuildPreparation["detachedProviderEntries"],
  scrubbedAdapterEntries: McpRebuildPreparation["scrubbedAdapterEntries"],
  runtimeSelection?: McpRebuildPreparation["runtimeSelection"],
): Promise<string | undefined> {
  try {
    await reattachMcpProvidersAfterRebuildAbort(
      sandboxName,
      entries,
      scrubbedAdapterEntries,
      runtimeSelection,
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function printMcpRebuildRetryCommand(
  sandboxName: string,
  entries: McpRebuildPreparation["entries"],
  toolDisclosure?: ToolDisclosure,
  observability?: { enabled: boolean; requestedExplicitly: boolean },
  dcodeAutoApproval?: {
    mode: DcodeAutoApprovalMode;
    requestedExplicitly: boolean;
  },
): void {
  const observabilityFlag = observability
    ? explicitObservabilityFlag(observability.enabled, observability.requestedExplicitly)
    : null;
  const observabilityArg = observabilityFlag ? ` ${observabilityFlag}` : "";
  const dcodeAutoApprovalArg = dcodeAutoApproval?.requestedExplicitly
    ? ` --dcode-auto-approval ${dcodeAutoApproval.mode}`
    : "";
  const disclosureArg = toolDisclosure ? ` --tool-disclosure ${toolDisclosure}` : "";
  // Recovery must re-enter rebuild so it loads the retained backup and the
  // original target fingerprint. Generic onboard resume owns a different
  // transaction and does not accept rebuild-only options such as DCode approval.
  console.error(
    `    2. Run: ${CLI_NAME} ${sandboxName} rebuild --yes${disclosureArg}${observabilityArg}${dcodeAutoApprovalArg}`,
  );
  console.error(
    `       This will recreate sandbox '${sandboxName}'${entries.length > 0 ? " and restore its MCP bridges" : ""}.`,
  );
}

export async function restoreMcpAfterRebuild(
  sandboxName: string,
  entries: McpRebuildPreparation["entries"],
  runtimeSelection?: McpRebuildPreparation["runtimeSelection"],
): Promise<boolean> {
  if (entries.length === 0) return true;
  console.log("  Restoring MCP bridges...");
  try {
    if (runtimeSelection) {
      await restoreMcpBridgesAfterRebuild(sandboxName, entries, runtimeSelection);
    } else {
      await restoreMcpBridgesAfterRebuild(sandboxName, entries);
    }
    console.log(`  ${G}✓${R} MCP bridges restored`);
    return true;
  } catch {
    console.error(`  ${YW}⚠${R} MCP bridge restore incomplete; inspect redacted diagnostics.`);
    return false;
  }
}

export function postRestoreCompleted(status: {
  hermesGatewayRestoreUnverified: boolean;
  messagingHostForwardUnverified: boolean;
  mcpBridgeRestoreUnverified: boolean;
  mutableConfigHashRefreshUnverified: boolean;
  mutablePermsRepairUnverified: boolean;
  restoreSucceeded: boolean;
}): boolean {
  return (
    status.restoreSucceeded &&
    !status.hermesGatewayRestoreUnverified &&
    !status.mutablePermsRepairUnverified &&
    !status.mutableConfigHashRefreshUnverified &&
    !status.messagingHostForwardUnverified &&
    !status.mcpBridgeRestoreUnverified
  );
}

export function printMcpRestoreRecovery(
  sandboxName: string,
  mcpBridgeRestoreUnverified: boolean,
): void {
  if (!mcpBridgeRestoreUnverified) return;
  console.log(
    `    MCP bridge definitions were preserved but not fully refreshed — fix the reported cause, then run \`${CLI_NAME} ${sandboxName} mcp restart\``,
  );
}
