// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerRmi } from "../../adapters/docker/image";
import { printOpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";
import { loadAgent } from "../../agent/defs";
import {
  bindLocalAgentBaseImageHandoffToResolution,
  bindLocalAgentBaseImageToPinnedProvenance,
  ensureAgentBaseImage,
  getAgentSandboxBaseImageEnvVar,
  pinAgentSandboxBaseImageRef,
  pinTrustedAgentBaseImageOverrideForOperation,
  pinTrustedAgentRemoteBaseImageOverrideForOperation,
} from "../../agent/onboard";
import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, G, R, YW } from "../../cli/terminal-style";
import {
  BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION,
  BACKUP_FAILURE_PERMISSION_DENIED,
  formatFailedBackupItems,
} from "../../domain/backup-failure";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "../../gateway-runtime-action";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../../openshell-sandbox-list";
import {
  parseContentAddressedSandboxBaseImageId,
  type SandboxBaseImageResolutionMetadata,
  type TrustedLocalBaseImageOverride,
} from "../../sandbox-base-image";
import * as shields from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import { load as loadRegistry } from "../../state/registry/persistence";
import * as sandboxState from "../../state/sandbox";
import * as userManagedFilesProbe from "../../state/user-managed-files-probe";
import {
  getReconciledSandboxGatewayState,
  printSandboxGatewayStateHint,
  printWrongGatewayActiveGuidance,
} from "./gateway-state";
import { openRebuildShieldsWindow, type RebuildShieldsWindow } from "./rebuild-shields";
import * as snapshotBackup from "./snapshot/backup-authority";

export { removeStaleRebuildDockerOrphan } from "../../onboard/openshell-docker-sandbox-containers";

export type RebuildSandboxEntry = SandboxEntry & { agents?: unknown[] };

export type RebuildLiveState = {
  staleRecovery: boolean;
  staleRegistrySnapshot: ReturnType<typeof loadRegistry> | null;
};

export type RebuildLiveStateOptions = {
  /** A digest-verified policy handoff bound to the prepared recovery manifest. */
  authoritativeRecoveryPolicyAvailable?: boolean;
};

export type RebuildAgentBaseImageOptions = {
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceBaseImageRefresh?: boolean;
};

export type RebuildAgentBaseImagePreflight = {
  ok: boolean;
  imageRef: string | null;
  overrideEnvVar: string | null;
  resolutionMetadata?: SandboxBaseImageResolutionMetadata;
  disposeImageRef?: () => boolean;
  trustedLocalOverride?: TrustedLocalBaseImageOverride;
  trustedRemoteOverride?: import("../../agent/base-image").TrustedRemoteBaseImageOverride;
};

const rebuildAgentBaseImageDisposalResults = new WeakMap<RebuildAgentBaseImagePreflight, boolean>();

function isCanonicalLocalBaseImageRef(agentName: string, imageRef: string): boolean {
  const escapedAgentName = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^nemoclaw-${escapedAgentName}-sandbox-base-local:image-[0-9a-f]{64}$`,
    "i",
  ).test(imageRef);
}

function isImmutableRemoteBaseImageRef(imageRef: string): boolean {
  return /^[^\s@]+@sha256:[0-9a-f]{64}$/i.test(imageRef);
}

export function disposeRebuildAgentBaseImagePreflight(
  preflight: RebuildAgentBaseImagePreflight | null | undefined,
): boolean {
  if (!preflight?.disposeImageRef) return true;
  const priorResult = rebuildAgentBaseImageDisposalResults.get(preflight);
  if (priorResult === true) return true;
  const result = preflight.disposeImageRef();
  if (result) rebuildAgentBaseImageDisposalResults.set(preflight, true);
  return result;
}

function createTemporaryBaseImageHandoffDisposer(imageRef: string): () => boolean {
  let removed = false;
  const dispose = (): boolean => {
    if (removed) return true;
    try {
      const removal = dockerRmi(imageRef, {
        ignoreError: true,
        suppressOutput: true,
      });
      if (!removal.error && removal.status === 0) {
        removed = true;
        process.removeListener("exit", dispose);
        return true;
      }
    } catch {
      // The caller reports the safe cleanup warning and can retry.
    }
    return false;
  };
  process.on("exit", dispose);
  return dispose;
}

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
  options: RebuildLiveStateOptions = {},
): Promise<RebuildLiveState | null> {
  const recordedGateway = resolveSandboxGatewayName(sb);
  log(`Checking sandbox liveness on ${recordedGateway}: openshell sandbox list`);
  const liveRecovery = await captureSandboxListWithGatewayRecovery({
    gatewayName: recordedGateway,
  });
  const observed = liveRecovery.result;
  if (!observed.ok && observed.error.kind === "schema") {
    printOpenShellStateRpcIssue(
      { kind: "protobuf_mismatch", drift: null, output: "" },
      {
        action: `rebuilding sandbox '${sandboxName}'`,
        command: `${CLI_NAME} ${sandboxName} rebuild`,
      },
    );
    bail("OpenShell gateway schema mismatch.");
    return null;
  }
  if (!observed.ok) {
    printSandboxListFailureWithRecoveryContext(liveRecovery);
    bail("Failed to query running sandboxes from OpenShell.", 1);
    return null;
  }

  const liveNames = new Set(observed.value.sandboxes.map((sandbox) => sandbox.name));
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
    if (options.authoritativeRecoveryPolicyAvailable === true) {
      log(
        "Stale-sandbox recovery: the sandbox is absent, but its transaction-bound policy handoff is intact",
      );
      return { staleRecovery: true, staleRegistrySnapshot: loadRegistry() };
    }
    console.log("");
    console.error(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' is registered locally but absent from the live OpenShell gateway.`,
    );
    console.error(
      "  Rebuild cannot recover its missing OpenShell policy or live workspace from NemoClaw registry metadata.",
    );
    console.error("  To create a clean replacement:");
    console.error(`    1. ${CLI_NAME} ${sandboxName} destroy --yes`);
    console.error(`    2. ${CLI_NAME} onboard`);
    console.error(
      "  The missing sandbox's state cannot be recovered unless you have a separate snapshot to restore after onboarding.",
    );
    bail("Cannot rebuild an absent sandbox without its authoritative OpenShell policy.");
    return null;
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
    printSandboxGatewayStateHint(reconciled, sandboxName, console.error);
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
  const explicitOverride = process.env[overrideEnvVar]?.trim();
  const hasExplicitOverride = Boolean(explicitOverride);
  try {
    // Prove that a retained local alias names the tracked official image before
    // the resolver sees it, and lease that proof only for this resolution call.
    // Arbitrary local overrides still fail closed in resolveSandboxBaseImage.
    const explicitOverrideResolution = explicitOverride
      ? bindLocalAgentBaseImageToPinnedProvenance(agentDef, explicitOverride)
      : null;
    const restoreExplicitOverrideTrust =
      explicitOverride && explicitOverrideResolution
        ? pinTrustedAgentRemoteBaseImageOverrideForOperation(overrideEnvVar, {
            ref: explicitOverride,
            resolutionMetadata: explicitOverrideResolution,
          })
        : () => undefined;
    let result: ReturnType<typeof ensureAgentBaseImage>;
    try {
      result = ensureAgentBaseImage(agentDef, {
        forceBaseImageRebuild: !hasExplicitOverride && !options.resolutionHint,
        ...(options.resolutionHint !== undefined ? { resolutionHint: options.resolutionHint } : {}),
        ...(options.forceBaseImageRefresh !== undefined
          ? { forceBaseImageRefresh: options.forceBaseImageRefresh }
          : {}),
      });
    } finally {
      restoreExplicitOverrideTrust();
    }
    if (agentDef.name === "nemocua") {
      if (!result.imageTag) throw new Error("NemoCUA caller image resolution returned no image");
      if (isImmutableRemoteBaseImageRef(result.imageTag)) {
        return { ok: true, imageRef: result.imageTag, overrideEnvVar };
      }
      const imageRef = pinAgentSandboxBaseImageRef(agentDef.name, result.imageTag, {
        forceLocal: true,
        temporary: true,
      });
      return {
        ok: true,
        imageRef,
        overrideEnvVar,
        disposeImageRef: createTemporaryBaseImageHandoffDisposer(imageRef),
      };
    }
    const reusedLocalResolution =
      result.resolutionMetadata?.source === "local" &&
      result.reusedResolutionHint === result.resolutionMetadata;
    if (
      !hasExplicitOverride &&
      result.imageTag &&
      result.resolutionMetadata?.source === "local" &&
      !result.trustedLocalOverride &&
      !reusedLocalResolution
    ) {
      // A stale persisted hint may fall through to a fresh local fallback. Its
      // public provenance label is not authority. Rebuild once so the build
      // call returns a fresh in-memory lease bound to the canonical image ID.
      result = ensureAgentBaseImage(agentDef, { forceBaseImageRebuild: true });
    }
    const needsTemporaryHandoff =
      result.imageTag !== null &&
      !isCanonicalLocalBaseImageRef(agentDef.name, result.imageTag) &&
      !isImmutableRemoteBaseImageRef(result.imageTag);
    const imageRef =
      result.imageTag && !isImmutableRemoteBaseImageRef(result.imageTag)
        ? pinAgentSandboxBaseImageRef(agentDef.name, result.imageTag, {
            forceLocal: true,
            ...(needsTemporaryHandoff ? { temporary: true } : {}),
          })
        : result.imageTag;
    const disposeImageRef =
      needsTemporaryHandoff && imageRef && imageRef !== result.imageTag
        ? createTemporaryBaseImageHandoffDisposer(imageRef)
        : undefined;
    const inheritedTrustedOverride =
      result.trustedLocalOverride?.ref === imageRef ? result.trustedLocalOverride : null;
    let handoffTrustedOverride: TrustedLocalBaseImageOverride | null = null;
    if (
      imageRef &&
      result.imageTag &&
      !inheritedTrustedOverride &&
      result.resolutionMetadata &&
      result.reusedResolutionHint === result.resolutionMetadata
    ) {
      handoffTrustedOverride = bindLocalAgentBaseImageHandoffToResolution(
        agentDef,
        result.imageTag,
        imageRef,
        result.resolutionMetadata,
        result.reusedResolutionHint,
      );
    }
    const localImageName = `nemoclaw-${agentDef.name}-sandbox-base-local`;
    const localHandoff =
      imageRef && parseContentAddressedSandboxBaseImageId(localImageName, imageRef) !== null;
    if (
      imageRef &&
      (needsTemporaryHandoff || localHandoff || result.resolutionMetadata?.source === "local") &&
      !inheritedTrustedOverride &&
      !handoffTrustedOverride
    ) {
      disposeImageRef?.();
      throw new Error(
        `Resolved ${agentDef.displayName} local base image could not be bound to its rebuild handoff`,
      );
    }
    const resolutionMetadata =
      result.resolutionMetadata ??
      explicitOverrideResolution ??
      (hasExplicitOverride && imageRef
        ? bindLocalAgentBaseImageToPinnedProvenance(agentDef, imageRef)
        : null);
    return {
      ok: true,
      imageRef,
      overrideEnvVar,
      ...(resolutionMetadata ? { resolutionMetadata } : {}),
      ...(disposeImageRef ? { disposeImageRef } : {}),
      ...(inheritedTrustedOverride
        ? { trustedLocalOverride: inheritedTrustedOverride }
        : handoffTrustedOverride
          ? { trustedLocalOverride: handoffTrustedOverride }
          : {}),
      ...(imageRef && resolutionMetadata && isImmutableRemoteBaseImageRef(imageRef)
        ? { trustedRemoteOverride: { ref: imageRef, resolutionMetadata } }
        : {}),
    };
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
  const restoreTrustedOverride = preflight.trustedLocalOverride
    ? pinTrustedAgentBaseImageOverrideForOperation(overrideEnvVar, preflight.trustedLocalOverride)
    : () => undefined;
  const restoreTrustedRemoteOverride = preflight.trustedRemoteOverride
    ? pinTrustedAgentRemoteBaseImageOverrideForOperation(
        overrideEnvVar,
        preflight.trustedRemoteOverride,
      )
    : () => undefined;
  env[overrideEnvVar] = imageRef;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreTrustedRemoteOverride();
    restoreTrustedOverride();
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
): sandboxState.RebuildManifest | null | undefined {
  if (staleRecovery) return null;

  console.log("  Backing up sandbox state...");
  log(`Agent type: ${sb.agent || "openclaw"}, stateDirs from manifest`);
  const backup = snapshotBackup.backupSandboxStateWithManagedAuthority(
    sandboxName,
    {},
    {
      getSandbox: (name) => loadRegistry().sandboxes[name] ?? null,
    },
  );
  log(
    `Backup result: success=${backup.success}, backed=${backup.backedUpDirs.join(",")}; files=${backup.backedUpFiles.join(",")}, failed=${backup.failedDirs.join(",")}; failedFiles=${backup.failedFiles.join(",")}`,
  );
  if (!backup.success) {
    console.error("  Failed to back up sandbox state.");
    const allStateDirsFailed =
      backup.backedUpDirs.length === 0 && backup.failedDirs.length > 0;
    if (allStateDirsFailed && backup.backedUpFiles.length > 0) {
      const dirCount = backup.failedDirs.length;
      const fileCount = backup.backedUpFiles.length;
      console.error(
        `  None of the ${dirCount} sandbox state ${dirCount === 1 ? "directory" : "directories"} could be preserved (only ${fileCount} loose ${fileCount === 1 ? "file was" : "files were"} saved).`,
      );
    }
    if (backup.failedDirs.length > 0) {
      const reasons = Object.values(backup.failedDirReasons ?? {});
      const anyPermissionDenied = reasons.includes(BACKUP_FAILURE_PERMISSION_DENIED);
      const allAbsent =
        reasons.length === backup.failedDirs.length &&
        reasons.every((reason) => reason === BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION);
      if (anyPermissionDenied) {
        console.error(
          "  The sandbox user could not read this state — the mounted files likely have wrong ownership or permissions, for example after a host reboot remapped the mount's UIDs.",
        );
      } else if (allAbsent) {
        console.error(
          "  The directories were reported by the sandbox but did not materialize on extraction — the mounted state may be unstable or disappearing under the container.",
        );
      } else {
        console.error(
          "  Inspect the per-directory failure reasons below along with the mount's ownership and permissions.",
        );
      }
    }
    if (backup.error) console.error(`  Reason: ${backup.error}`);
    if (backup.failedDirs.length > 0)
      console.error(
        `  Failed: ${formatFailedBackupItems(backup.failedDirs, backup.failedDirReasons)}`,
      );
    if (backup.failedFiles.length > 0)
      console.error(`  Failed files: ${backup.failedFiles.join(", ")}`);
    if (backup.manifest?.backupPath) {
      console.error(
        `  Incomplete snapshot retained for manual recovery: ${backup.manifest.backupPath}`,
      );
      console.error("  It is excluded from snapshot restore selection.");
    }
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
  console.log(
    `  ${G}✓${R} State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
  );
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
