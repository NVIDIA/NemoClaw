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
  prepareMcpBridgesForExecUnavailableRebuild,
  prepareMcpBridgesForRebuild,
  reattachMcpProvidersAfterRebuildAbort,
  restoreMcpBridgesAfterRebuild,
} from "./mcp-bridge";
import { executeSandboxCommand, executeSandboxExecCommand } from "./process-recovery";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

export type McpRebuildPreparation = Awaited<ReturnType<typeof prepareMcpBridgesForRebuild>>;

function canExecuteMcpPreparation(sandboxName: string): boolean {
  // Live MCP preparation uses both transports: SSH-backed adapter
  // inspection/mutation and OpenShell-mediated adapter/provider operations.
  // Prove both before any mutation. A direct Docker fallback would not prove
  // that the OpenShell transport itself can run.
  const sshProbe = executeSandboxCommand(sandboxName, ":");
  const execProbe = executeSandboxExecCommand(sandboxName, ":", undefined, {
    allowLocalDockerFallback: false,
  });
  return sshProbe !== null && sshProbe.status === 0 && execProbe !== null && execProbe.status === 0;
}

export async function prepareMcpForRebuild(
  sandboxName: string,
  staleRecovery: boolean,
  force: boolean,
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean,
  bail: RebuildBail,
): Promise<McpRebuildPreparation | null> {
  // invalidState: OpenShell still reports a live sandbox, but the
  // side-effect-free `:` command cannot cross every transport required by live
  // MCP preparation. Every nonzero result is non-authoritative, so interpreting
  // selected exit codes as proof teardown can run would cross the delete edge.
  // sourceBoundary: the pinned OpenShell sandbox-exec and SSH transports own
  // these liveness signals; NemoClaw owns only explicit --force recovery policy.
  // whyNotSourceFix: an unreachable retained image cannot be repaired before
  // rebuild, and OpenShell v0.0.85 exposes no stronger adapter-health proof.
  // regressionTest: rebuild-mcp-phase.test.ts exercises null and representative
  // nonzero results through this exact force-only branch.
  // removalCondition: remove this fallback only when OpenShell exposes an
  // attested read-only adapter snapshot that is safe without sandbox transport.
  if (force && !staleRecovery && !canExecuteMcpPreparation(sandboxName)) {
    console.error(`  ${YW}⚠${R} MCP transport probe failed; --force using host-side MCP recovery`);
    try {
      return await prepareMcpBridgesForExecUnavailableRebuild(sandboxName);
    } catch (error) {
      relockShieldsIfNeeded(true);
      bail(
        `Failed to preserve MCP bridges before rebuild (--force host-side recovery): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

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
  // The recreate fault can land after the sandbox was deleted but before create
  // recorded its name, leaving the resumable onboard session with no name to
  // resume. Carry --name so this printed command works as written instead of
  // failing with "no sandbox name was recorded. Re-run with --name".
  console.error(
    `    2. Run: ${CLI_NAME} onboard --resume --name ${sandboxName}${disclosureArg}${observabilityArg}${dcodeAutoApprovalArg}`,
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
  hermesGatewayRestoreUnverified: boolean;
  messagingHostForwardUnverified: boolean;
  mcpBridgeRestoreUnverified: boolean;
  mutableConfigHashRefreshUnverified: boolean;
  mutablePermsRepairUnverified: boolean;
  policyPresetRestoreIncomplete: boolean;
  restoreSucceeded: boolean;
}): boolean {
  return (
    status.restoreSucceeded &&
    !status.hermesGatewayRestoreUnverified &&
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
