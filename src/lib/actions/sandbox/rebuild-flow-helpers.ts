// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { loadAgent } from "../../agent/defs";
import {
  ensureAgentBaseImage,
  getAgentSandboxBaseImageEnvVar,
  pinAgentSandboxBaseImageRef,
} from "../../agent/onboard";
import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, G, R, YW } from "../../cli/terminal-style";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "../../gateway-runtime-action";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../../openshell-sandbox-list";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import * as userManagedFilesProbe from "../../state/user-managed-files-probe";
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

export type RebuildAgentBaseImageOptions = {
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh?: boolean;
};

export type RebuildAgentBaseImagePreflight = {
  ok: boolean;
  imageRef: string | null;
  overrideEnvVar: string | null;
};

/**
 * Select, health-check, and process-pin the gateway recorded for this sandbox
 * before any provider or credential preflight. OpenShell's global selection is
 * shared mutable metadata; OPENSHELL_GATEWAY keeps every later subprocess in
 * this rebuild on the target even if another process selects a sibling gateway.
 */
export async function ensureRebuildTargetGatewaySelected(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  log: (message: string) => void,
  bail: (message: string, code?: number) => never,
): Promise<boolean> {
  const gatewayName = resolveSandboxGatewayName(sb);
  const recovery = await recoverNamedGatewayRuntime({ gatewayName });
  if (!recovery.recovered || recovery.after.state !== "healthy_named") {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} could not select the target gateway '${gatewayName}'.`,
    );
    console.error(
      `  Gateway state before: ${recovery.before.state}; after: ${recovery.after.state}.`,
    );
    console.error("  Sandbox is untouched — no data was lost.");
    bail(`Could not select healthy gateway '${gatewayName}' for sandbox '${sandboxName}'`);
    return false;
  }
  process.env.OPENSHELL_GATEWAY = gatewayName;
  log(`Pinned rebuild subprocesses to target gateway '${gatewayName}'`);
  return true;
}

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
  const liveListIssue = detectOpenShellStateRpcResultIssue(isLive, {
    gatewayName: recordedGateway,
  });
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
  recoveryRecreate: boolean,
): { rebuildShieldsWindow: RebuildShieldsWindow | null; staleSandboxWasLocked: boolean } {
  if (recoveryRecreate) {
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
  options: RebuildAgentBaseImageOptions = {},
): RebuildAgentBaseImagePreflight {
  if (!rebuildAgent) return { ok: true, imageRef: null, overrideEnvVar: null };
  const agentDef = loadAgent(rebuildAgent);
  const overrideEnvVar = getAgentSandboxBaseImageEnvVar(agentDef.name);
  const hasExplicitOverride = Boolean(process.env[overrideEnvVar]?.trim());
  try {
    const result = ensureAgentBaseImage(agentDef, {
      forceBaseImageRebuild: !hasExplicitOverride && !options.resolutionHint,
      ...(options.resolutionHint !== undefined ? { resolutionHint: options.resolutionHint } : {}),
      ...(options.forceBaseImageRefresh !== undefined
        ? { forceBaseImageRefresh: options.forceBaseImageRefresh }
        : {}),
    });
    const imageRef =
      hasExplicitOverride && result.imageTag
        ? pinAgentSandboxBaseImageRef(agentDef.name, result.imageTag)
        : result.imageTag;
    return { ok: true, imageRef, overrideEnvVar };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Rebuild preflight failed:${R} agent base image could not be built.`);
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return { ok: false, imageRef: null, overrideEnvVar: null };
  }
}

export function pinRebuildAgentBaseImageForRecreate(
  preflight: RebuildAgentBaseImagePreflight,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const { imageRef, overrideEnvVar } = preflight;
  if (!preflight.ok || !imageRef || !overrideEnvVar) return () => undefined;

  const hadPriorValue = Object.hasOwn(env, overrideEnvVar);
  const priorValue = env[overrideEnvVar];
  env[overrideEnvVar] = imageRef;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (hadPriorValue && priorValue !== undefined) {
      env[overrideEnvVar] = priorValue;
    } else {
      delete env[overrideEnvVar];
    }
  };
}

export function backupSandboxStateForRebuild(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  staleRecovery: boolean,
  log: (msg: string) => void,
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean,
  bail: (msg: string, code?: number) => never,
  options?: { force?: boolean },
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
    if (options?.force) {
      console.warn(
        `  ${YW}⚠${R} Backup failed but --force was specified — skipping backup and rebuilding from registry metadata.`,
      );
      log(
        "Force-skip: backup failed completely; continuing without backup as requested by --force",
      );
      return null;
    }
    console.error("  Failed to back up sandbox state.");
    if (backup.error) console.error(`  Reason: ${backup.error}`);
    if (backup.failedDirs.length > 0) console.error(`  Failed: ${backup.failedDirs.join(", ")}`);
    if (backup.failedFiles.length > 0)
      console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
    console.error("  Aborting rebuild to prevent data loss.");
    console.error(
      `  Hint: use '${CLI_NAME} ${sandboxName} rebuild --force' to skip backup and rebuild from registry metadata.`,
    );
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

/**
 * Warn only after MCP rebuild preparation has scrubbed NemoClaw-owned adapter
 * entries. In particular, a managed-only Deep Agents `.mcp.json` is removed by
 * that transaction; if the file still exists at this point it contains
 * additional user-owned content that the state backup intentionally excludes.
 */
export function warnUnpreservedUserManagedFiles(
  sandboxName: string,
  log: (msg: string) => void,
): void {
  let probe: userManagedFilesProbe.UserManagedFilesProbe;
  try {
    probe = userManagedFilesProbe.probeUserManagedFiles(sandboxName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`User-managed file probe errored: ${message}`);
    console.warn(
      `  ${YW}⚠${R} Could not check declared user-managed files before rebuild (probe failed).`,
    );
    console.warn(
      "    Re-add any user-managed files you keep in the sandbox after rebuild, or manage them from the host.",
    );
    return;
  }
  if (probe.existing.length === 0) {
    if (probe.declared.length > 0) {
      log(`User-managed files declared but none present in sandbox: [${probe.declared.join(",")}]`);
    }
    return;
  }
  console.warn(
    `  ${YW}⚠${R} User-managed files will not be preserved if rebuild replaces this sandbox: ${probe.existing.join(", ")}`,
  );
  console.warn("    After a successful rebuild, re-add them or manage them from the host.");
}
