// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import { explicitObservabilityFlag } from "../../onboard/observability-command-flag";
import * as registry from "../../state/registry";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForRebuild,
  reattachMcpProvidersAfterRebuildAbort,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

export type McpRebuildPreparation = Awaited<ReturnType<typeof prepareMcpBridgesForRebuild>>;

export async function prepareMcpForRebuild(
  sandboxName: string,
  staleRecovery: boolean,
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean,
  bail: (message: string, code?: number) => never,
): Promise<McpRebuildPreparation | null> {
  try {
    return await (staleRecovery
      ? prepareMcpBridgesForAbsentSandboxRebuild(sandboxName)
      : prepareMcpBridgesForRebuild(sandboxName));
  } catch (error) {
    relockShieldsIfNeeded(!staleRecovery);
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
): Promise<string | undefined> {
  try {
    await reattachMcpProvidersAfterRebuildAbort(sandboxName, entries, scrubbedAdapterEntries);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function restoreMcpRegistryForRebuildRetry(
  staleRecovery: boolean,
  entries: McpRebuildPreparation["entries"],
  original: RebuildSandboxEntry,
  log: (message: string) => void,
): void {
  if (staleRecovery || entries.length === 0) return;
  try {
    // MCP-bearing rebuilds deliberately preserve the registry entry instead of
    // removing it. Restore any metadata overwritten by a partial onboard, but
    // leave the current default pointer alone: a concurrent `nemoclaw use`
    // selection must win because this rebuild never moved that pointer.
    registry.restoreSandboxEntry(original);
    log("Recreate failed: restored MCP-bearing registry entry for stale recovery retry");
  } catch (error) {
    log(`Failed to restore MCP-bearing registry entry after recreate failure: ${String(error)}`);
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
  if (entries.length > 0) {
    const disclosureArg = toolDisclosure ? ` --tool-disclosure ${toolDisclosure}` : "";
    console.error(
      `    2. Run: ${CLI_NAME} ${sandboxName} rebuild --yes${disclosureArg}${observabilityArg}${dcodeAutoApprovalArg}`,
    );
    console.error(
      `       This will recreate sandbox '${sandboxName}' and restore its MCP bridges.`,
    );
    return;
  }
  const disclosureArg = toolDisclosure ? ` --tool-disclosure ${toolDisclosure}` : "";
  console.error(
    `    2. Run: ${CLI_NAME} onboard --resume${disclosureArg}${observabilityArg}${dcodeAutoApprovalArg}`,
  );
  console.error(`       This will recreate sandbox '${sandboxName}'.`);
}

export async function restoreMcpAfterRebuild(
  sandboxName: string,
  entries: McpRebuildPreparation["entries"],
): Promise<boolean> {
  if (entries.length === 0) return true;
  console.log("  Restoring MCP bridges...");
  try {
    await restoreMcpBridgesAfterRebuild(sandboxName, entries);
    console.log(`  ${G}✓${R} MCP bridges restored`);
    return true;
  } catch (error) {
    console.error(
      `  ${YW}⚠${R} MCP bridge restore incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function postRestoreCompleted(status: {
  messagingHostForwardUnverified: boolean;
  mcpBridgeRestoreUnverified: boolean;
  mutableConfigHashRefreshUnverified: boolean;
  mutablePermsRepairUnverified: boolean;
  policyPresetRestoreIncomplete: boolean;
  restoreSucceeded: boolean;
}): boolean {
  return (
    status.restoreSucceeded &&
    !status.mutablePermsRepairUnverified &&
    !status.mutableConfigHashRefreshUnverified &&
    !status.messagingHostForwardUnverified &&
    !status.mcpBridgeRestoreUnverified &&
    !status.policyPresetRestoreIncomplete
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
