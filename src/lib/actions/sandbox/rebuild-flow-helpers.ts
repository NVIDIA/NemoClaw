// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { ensureAgentBaseImage } from "../../agent/onboard";
import { RD as _RD, G, R, YW } from "../../cli/terminal-style";
import { getNamedGatewayLifecycleState } from "../../gateway-runtime-action";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../../openshell-sandbox-list";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import { loadAgent } from "../../agent/defs";
import { CLI_NAME } from "../../cli/branding";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  getReconciledSandboxGatewayState,
  printGatewayLifecycleHint,
  printWrongGatewayActiveGuidance,
} from "./gateway-state";
import { openRebuildShieldsWindow, type RebuildShieldsWindow } from "./rebuild-shields";

export type RebuildSandboxEntry = registry.SandboxEntry & { agents?: unknown[] };

export type RebuildLiveState = {
  staleRecovery: boolean;
  staleRegistrySnapshot: ReturnType<typeof registry.load> | null;
};

export async function resolveRebuildLiveState(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): Promise<RebuildLiveState | null> {
  const recordedGateway = resolveSandboxGatewayName(sb);
  log(`Checking sandbox liveness on ${recordedGateway}: openshell sandbox list`);
  const liveRecovery = await captureSandboxListWithGatewayRecovery({
    gatewayName: recordedGateway,
  });
  const isLive = liveRecovery.result;
  log(
    `openshell sandbox list exit=${isLive.status}, output=${(isLive.output || "").substring(0, 200)}`,
  );
  const liveListIssue = detectOpenShellStateRpcResultIssue(isLive);
  if (liveListIssue) {
    printOpenShellStateRpcIssue(liveListIssue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    bail("OpenShell gateway schema mismatch.");
    return null;
  }
  if (isLive.status !== 0) {
    printSandboxListFailureWithRecoveryContext(liveRecovery);
    bail("Failed to query running sandboxes from OpenShell.", isLive.status || 1);
    return null;
  }

  const liveNames = parseLiveSandboxNames(isLive.output || "");
  log(`Live sandboxes: ${Array.from(liveNames).join(", ") || "(none)"}`);
  if (liveNames.has(sandboxName)) return { staleRecovery: false, staleRegistrySnapshot: null };

  const reconciled = await getReconciledSandboxGatewayState(sandboxName);
  if (reconciled.state === "present") {
    const lifecycle = getNamedGatewayLifecycleState(recordedGateway);
    if (lifecycle.state !== "healthy_named") {
      printWrongGatewayActiveGuidance(
        sandboxName,
        lifecycle.activeGateway,
        console.error,
        "rebuild --yes",
      );
      bail(
        `Could not confirm '${sandboxName}' against gateway '${recordedGateway}' (gateway '${lifecycle.activeGateway ?? "unknown"}' is active).`,
      );
      return null;
    }
    log("Sandbox live on the healthy named gateway; using normal rebuild path");
    return { staleRecovery: false, staleRegistrySnapshot: null };
  }

  if (reconciled.state === "missing") {
    // Source boundary: the local registry is the durable NemoClaw intent record,
    // while OpenShell owns live sandbox presence. A missing live sandbox on a
    // healthy named gateway can come from external deletion or failed prior
    // provisioning, so rebuild recovers from registry metadata instead of
    // treating the preserved local entry as corrupt. Keep until OpenShell exposes
    // an atomic recreate-from-registry recovery API.
    console.log("");
    console.log(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' is registered locally but absent from the live OpenShell gateway.`,
    );
    console.log(
      "  No live workspace state to back up — recreating from the preserved registry metadata.",
    );
    log(
      "Stale-sandbox recovery: live sandbox missing on healthy named gateway; skipping backup/restore and recreating from registry metadata",
    );
    return {
      staleRecovery: true,
      staleRegistrySnapshot: JSON.parse(JSON.stringify(registry.load())),
    };
  }

  if (reconciled.state === "gateway_schema_mismatch") {
    console.error(reconciled.output);
    bail("OpenShell gateway schema mismatch.");
    return null;
  }

  if (reconciled.state === "wrong_gateway_active") {
    printWrongGatewayActiveGuidance(
      sandboxName,
      reconciled.activeGateway,
      console.error,
      "rebuild --yes",
    );
  } else {
    console.error(
      `  Sandbox '${sandboxName}' is not visible on gateway '${recordedGateway}' and its live state could not be confirmed.`,
    );
    console.error("  Your local registry entry has been preserved — nothing was removed.");
    printGatewayLifecycleHint(reconciled.output || "", sandboxName, console.error);
  }
  bail(`Could not confirm live state of '${sandboxName}' (gateway not in a known-good state).`);
  return null;
}

export function openRebuildShieldsWindowForState(
  sandboxName: string,
  staleRecovery: boolean,
): { rebuildShieldsWindow: RebuildShieldsWindow | null; staleSandboxWasLocked: boolean } {
  if (staleRecovery) {
    return {
      staleSandboxWasLocked: !shields.isShieldsDown(sandboxName),
      rebuildShieldsWindow: { relocked: false, wasLocked: false },
    };
  }
  return {
    staleSandboxWasLocked: false,
    rebuildShieldsWindow: openRebuildShieldsWindow(sandboxName, CLI_NAME),
  };
}

export function ensureRebuildAgentBaseImage(
  rebuildAgent: string | null,
  bail: (msg: string, code?: number) => never,
): boolean {
  if (!rebuildAgent) return true;
  const agentDef = loadAgent(rebuildAgent);
  try {
    ensureAgentBaseImage(agentDef, { forceBaseImageRebuild: true });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} agent base image could not be built.`);
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return false;
  }
}

export function backupSandboxStateForRebuild(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  staleRecovery: boolean,
  log: (msg: string) => void,
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean,
  bail: (msg: string, code?: number) => never,
): sandboxState.RebuildManifest | null | undefined {
  if (staleRecovery) return null;

  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = sandboxState.backupSandboxState(sandboxName);
  log(
    `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}; files=${backup.backedUpFiles.join(",")}, failed=${backup.failedDirs.join(",")}; failedFiles=${backup.failedFiles.join(",")}`,
  );
  const hasAnyBackup = backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0;
  if (!backup.success && !hasAnyBackup) {
    console.error("  Failed to back up sandbox state.");
    if (backup.failedDirs.length > 0) console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    if (backup.failedFiles.length > 0)
      console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
    console.error("  Aborting rebuild to prevent data loss.");
    relockShieldsIfNeeded(true);
    bail("Failed to back up sandbox state.");
    return undefined;
  }
  const backupManifest = backup.manifest ?? null;
  if (!backupManifest) {
    console.error("  Failed to record backup metadata.");
    console.error("  Aborting rebuild to prevent data loss.");
    relockShieldsIfNeeded(true);
    bail("Failed to record backup metadata.");
    return undefined;
  }
  if (!backup.success) {
    console.warn(
      `  ${YW}⚠${R} Partial backup: ${backup.backedUpDirs.length} dirs and ${backup.backedUpFiles.length} files OK; ${backup.failedDirs.length} dirs and ${backup.failedFiles.length} files failed`,
    );
    if (backup.failedDirs.length > 0)
      console.warn(`    Failed dirs: ${backup.failedDirs.join(", ")}`);
    if (backup.failedFiles.length > 0)
      console.warn(`    Failed files: ${backup.failedFiles.join(", ")}`);
    console.warn("    Rebuild will continue — failed state could not be preserved.");
  } else {
    console.log(
      `  ${G}✓${R} State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
    );
  }
  console.log(`    Backup: ${backupManifest.backupPath}`);
  return backupManifest;
}
