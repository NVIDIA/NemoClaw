// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import * as sandboxVersion from "../../sandbox/version";
import { inspectMutableHermesConfigPerms } from "../../sandbox/mutable-config-perms";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { HermesOperatorConfigRestoreReport } from "./rebuild-durable-config";
import {
  completeHermesCronRestoreAfterGatewayReplacement,
  type HermesCronRestoreIdentity,
  type HermesPostRestoreGatewayRestartState,
  isHermesCronRestoreDrainMarkerRollbackFailure,
  printHermesGatewayRestoreRecovery,
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";
import { getPersistedSandboxTargetGatewayName } from "./gateway-target";
import {
  type McpRebuildPreparation,
  postRestoreCompleted,
  printMcpRestoreRecovery,
  restoreMcpAfterRebuild,
} from "./rebuild-mcp-phase";
import {
  finalizePendingMessagingRemovalsAfterRestore,
  reapplyMessagingManifestBeforeOpenClawStart,
} from "./rebuild-messaging-phase";
import {
  abortOpenClawPostRestoreDoctor,
  beginOpenClawPostRestoreDoctor,
  finishOpenClawPostRestoreDoctor,
  type OpenClawPostRestoreDoctorWindow,
} from "./runtime/openclaw-lifecycle";
import { reconcileStalePinnedSessionModelsAfterRebuild } from "./reconcile-session-models";

export {
  type HermesCronRestoreIdentity,
  HermesCronRestoreIncompleteError,
  recoverHermesCronRestore,
  runHermesCronRestoreTransaction,
} from "./rebuild-hermes-post-restore";

/** Probe the recreated runtime instead of accepting its requested version metadata. */
function probeRebuiltAgentVersion(
  sandboxName: string,
): ReturnType<typeof sandboxVersion.checkAgentVersion> {
  return sandboxVersion.checkAgentVersion(sandboxName, { forceProbe: true });
}

export function printHermesCronRestoreRecoveryCommand(
  sandboxName: string,
  writeLine: (message: string) => void = console.error,
): void {
  writeLine(
    `  Correct the reported restore problem, then run \`${CLI_NAME} ${sandboxName} recover\`.`,
  );
}

function bailAfterHermesCronRestoreFailure(
  sandboxName: string,
  backupManifest: RebuildBackupManifest,
  detail: string,
  bailMessage: string,
  bail: RebuildBail,
  beforeCronRecovery?: () => void,
): never {
  console.error(detail);
  if (backupManifest) {
    console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
  }
  beforeCronRecovery?.();
  printHermesCronRestoreRecoveryCommand(sandboxName);
  return bail(bailMessage);
}

export interface RebuildPostRestorePhaseInput {
  sandboxName: string;
  targetAgentName: string;
  messagingPlan: SandboxMessagingPlan | null;
  backupManifest: RebuildBackupManifest;
  mcpEntries: McpRebuildPreparation["entries"];
  mcpRuntimeSelection?: McpRebuildPreparation["runtimeSelection"];
  recheckMessagingConflicts?: (
    runtimeSelection: McpRebuildPreparation["runtimeSelection"],
    onConflict: RebuildBail,
  ) => Promise<void>;
  restoreSucceeded: boolean;
  openClawDoctorWindow?: OpenClawPostRestoreDoctorWindow;
  hermesOperatorConfigRestore?: HermesOperatorConfigRestoreReport;
  hermesCronRestoreIdentity?: HermesCronRestoreIdentity;
  preparedBackupRecovery: boolean;
  versionCheck: sandboxVersion.VersionCheckResult;
  log: RebuildLog;
  bail: RebuildBail;
}

export interface RebuildPostRestoreVerification {
  readonly mutableConfigPermissionsVerified: boolean;
}

export function printHermesOperatorConfigRestoreReport(
  targetAgentName: string,
  report: HermesOperatorConfigRestoreReport | undefined,
): void {
  if (targetAgentName !== "hermes" || !report) return;
  const restored = report.restoredKeys.join(", ") || "none";
  const dropped = report.droppedKeys.join(", ") || "none";
  console.log(`    Restored Hermes operator config keys: ${restored}`);
  console.log(`    Dropped Hermes operator config keys: ${dropped}`);
}

function printHermesApiTokenChangeNotice(sandboxName: string, targetAgentName: string): void {
  if (targetAgentName !== "hermes") {
    return;
  }
  console.log(`    ${YW}\u26a0${R} Hermes API bearer token changed during rebuild.`);
  console.log(
    `    Retrieve the new token with \`${CLI_NAME} ${sandboxName} gateway-token --quiet\`.`,
  );
}

async function resolveOpenClawPostRestoreWindow(
  sandboxName: string,
  preparedWindow: OpenClawPostRestoreDoctorWindow | null,
  runtimeSelection: McpRebuildPreparation["runtimeSelection"] | undefined,
  log: RebuildLog,
  bail: RebuildBail,
): Promise<OpenClawPostRestoreDoctorWindow | null> {
  if (preparedWindow) return preparedWindow;
  // Retained accepted-target recovery records from older NemoClaw builds do
  // not carry the pre-restore window. Preserve their established recovery
  // path while every current restore supplies the window before mutation.
  log("Entering verified OpenClaw post-upgrade maintenance window");
  const doctorWindow = await beginOpenClawPostRestoreDoctor(sandboxName, runtimeSelection);
  log(
    `Post-upgrade doctor maintenance window: ${doctorWindow.ok ? "verified" : doctorWindow.stage}`,
  );
  if (doctorWindow.ok) return doctorWindow.window;
  console.log(`  ${D}Post-upgrade structure repair failed before offline restoration${R}`);
  bail("OpenClaw post-upgrade structure repair failed during rebuild.");
  return null;
}

async function abortOpenClawPostRestoreWindowAfterFailure(
  doctorWindow: OpenClawPostRestoreDoctorWindow,
  log: RebuildLog,
): Promise<void> {
  log("Aborting OpenClaw post-upgrade maintenance window after rebuild failure");
  try {
    const abortResult = await abortOpenClawPostRestoreDoctor(doctorWindow);
    log(`Post-upgrade doctor maintenance abort: ${abortResult.ok ? "verified" : "unverified"}`);
    if (!abortResult.ok) {
      console.error(
        `  ${YW}\u26a0${R} OpenClaw maintenance abort could not prove the sandbox stopped.`,
      );
    }
  } catch {
    log("Post-upgrade doctor maintenance abort: unverified");
    console.error(
      `  ${YW}\u26a0${R} OpenClaw maintenance abort could not prove the sandbox stopped.`,
    );
  }
}

/**
 * Repair agent state, restore MCP/forwarding, reconcile non-MCP registry state, and report
 * the final transaction result. Boundary coverage: rebuild-flow.test.ts covers
 * the complete/incomplete post-restore paths; rebuild-post-restore-phase.test.ts
 * covers forwarding recovery reports.
 */
export async function runRebuildPostRestorePhase(
  input: RebuildPostRestorePhaseInput,
): Promise<RebuildPostRestoreVerification | undefined> {
  const {
    sandboxName,
    targetAgentName,
    messagingPlan,
    backupManifest,
    mcpEntries,
    mcpRuntimeSelection,
    restoreSucceeded,
    openClawDoctorWindow: preparedOpenClawDoctorWindow,
    hermesOperatorConfigRestore,
    hermesCronRestoreIdentity,
    preparedBackupRecovery,
    versionCheck,
    log,
    bail,
  } = input;
  const recreatedEntry = registry.getSandbox(sandboxName);
  const recreatedAgent = agentRuntime.getSessionAgent(sandboxName);
  // OpenClaw is represented by a null registry agent and a null runtime definition.
  const recreatedRegistryAgentName = recreatedEntry?.agent ?? "openclaw";
  const recreatedRuntimeAgentName = recreatedAgent?.name ?? "openclaw";
  if (
    !recreatedEntry ||
    recreatedRegistryAgentName !== targetAgentName ||
    recreatedRuntimeAgentName !== targetAgentName ||
    (targetAgentName === "hermes" &&
      mcpRuntimeSelection &&
      getPersistedSandboxTargetGatewayName(recreatedEntry) !== mcpRuntimeSelection.gatewayName)
  ) {
    console.error(
      `  ${YW}\u26a0${R} Recreated sandbox agent identity could not be verified against the rebuild target.`,
    );
    if (hermesCronRestoreIdentity) {
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because the replacement identity is unverified.",
        "Recreated sandbox agent identity did not match the authoritative rebuild target.",
        bail,
      );
    }
    bail("Recreated sandbox agent identity did not match the authoritative rebuild target.");
    return;
  }
  const agentDef = loadAgent(targetAgentName);
  const rebuiltAgentName = agentDef.displayName;
  let mutableConfigPermissionsVerified = targetAgentName !== "hermes";
  let messagingHostForwardUnverified = false;
  let effectiveMessagingPlan = messagingPlan;
  let openClawDoctorWindow: OpenClawPostRestoreDoctorWindow | null =
    preparedOpenClawDoctorWindow ?? null;
  let hermesGatewayRestartState: HermesPostRestoreGatewayRestartState = "not-applicable";
  let mcpBridgeRestoreUnverified = true;
  // Rebuild freezes the OpenShell target before deletion and revalidates the
  // recreated registry binding above. Native restart and health checks remain
  // pinned to that selected runtime.
  const hermesPostRestoreGatewayDeps = mcpRuntimeSelection
    ? {
        runtimeSelection: mcpRuntimeSelection,
      }
    : {};

  try {
    if (targetAgentName === "openclaw") {
      // The restore phase enters this window before replacing any live state.
      // Keep that exact window through every post-restore writer and release it
      // only after the final config mutation.
      openClawDoctorWindow = await resolveOpenClawPostRestoreWindow(
        sandboxName,
        openClawDoctorWindow,
        mcpRuntimeSelection,
        log,
        bail,
      );
      if (!openClawDoctorWindow) return;

      // #7102: clear stale per-session pinned models left over from an
      // `inference set` before this rebuild. The maintenance receipt above proves
      // that OpenClaw cannot race this sessions.json mutation.
      await reconcileStalePinnedSessionModelsAfterRebuild(sandboxName, log, mcpRuntimeSelection);

      try {
        await reapplyMessagingManifestBeforeOpenClawStart(
          sandboxName,
          messagingPlan,
          log,
          mcpRuntimeSelection,
        );
      } catch (error) {
        log(
          `Messaging manifest reapply failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(
          `  ${YW}\u26a0${R} Messaging manifest config reapply failed before gateway start.`,
        );
        bail("OpenClaw messaging manifest config reapply failed during rebuild.");
        return;
      }
    }

    try {
      const finalizedMessagingPlan = finalizePendingMessagingRemovalsAfterRestore(
        effectiveMessagingPlan,
        log,
        mcpRuntimeSelection,
      );
      if (finalizedMessagingPlan !== effectiveMessagingPlan && finalizedMessagingPlan) {
        if (
          !registry.updateSandbox(sandboxName, {
            messaging: { schemaVersion: 1, plan: finalizedMessagingPlan },
          })
        ) {
          bail("Could not retire pending messaging removals after rebuild.");
          return;
        }
        effectiveMessagingPlan = finalizedMessagingPlan;
      }
    } catch (error) {
      bail(
        `Could not finalize pending messaging removals after rebuild: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    // The managed image owns the ordinary Hermes process lifecycle. Only an
    // active cron-restore gate requires the bounded replacement transaction that
    // keeps dispatch drained across a process identity change.
    hermesGatewayRestartState = hermesCronRestoreIdentity
      ? await restartHermesGatewayAfterStateRestore(
          sandboxName,
          targetAgentName,
          hermesPostRestoreGatewayDeps,
        )
      : "not-applicable";
    mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(
      sandboxName,
      mcpEntries,
      mcpRuntimeSelection,
    ));
    if (targetAgentName === "openclaw") {
      if (!openClawDoctorWindow) {
        bail("OpenClaw post-upgrade maintenance authority was lost during rebuild.");
        return;
      }
      log("Releasing OpenClaw for one final start after all offline post-restore writes");
      const doctorResult = await finishOpenClawPostRestoreDoctor(openClawDoctorWindow);
      log(`Post-upgrade doctor final start: ${doctorResult.ok ? "verified" : doctorResult.stage}`);
      if (!doctorResult.ok) {
        console.log(`  ${D}Post-upgrade structure repair failed during final sandbox start${R}`);
        console.error(`  ${doctorResult.detail.replaceAll("\n", "\n  ")}`);
        bail("OpenClaw post-upgrade structure repair failed during rebuild.");
        return;
      }
      openClawDoctorWindow = null;
      console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
    }
  } finally {
    if (openClawDoctorWindow) {
      await abortOpenClawPostRestoreWindowAfterFailure(openClawDoctorWindow, log);
    }
  }
  const hermesGatewayVerification = hermesCronRestoreIdentity
    ? await verifyHermesGatewayAfterStateRestoreForCronGate(
        sandboxName,
        targetAgentName,
        hermesGatewayRestartState,
        hermesCronRestoreIdentity,
        hermesPostRestoreGatewayDeps,
      )
    : { state: "not-applicable" as const, replacementIdentity: undefined };
  const hermesGatewayRestoreState = hermesGatewayVerification.state;
  const hermesGatewayRestoreUnverified = hermesGatewayRestoreState === "unverified";
  let verifiedAgentVersion: string | null = null;
  if (versionCheck.expectedVersion) {
    // The replacement runtime is the only authority for the completed rebuild
    // version. Clear create-time bookkeeping before the forced live probe so a
    // failed probe cannot leave the requested version recorded as observed.
    registry.updateSandbox(sandboxName, { agentVersion: null });
    const rebuiltVersion = await probeRebuiltAgentVersion(sandboxName);
    if (
      rebuiltVersion.verificationFailed ||
      rebuiltVersion.sandboxVersion !== versionCheck.expectedVersion
    ) {
      // checkAgentVersion caches a successful probe. Do not retain metadata
      // from a replacement that this rebuild rejects.
      registry.updateSandbox(sandboxName, { agentVersion: null });
      const observed = rebuiltVersion.sandboxVersion ?? "unverified";
      const detail = `  Replacement agent version did not match the rebuild target (expected ${versionCheck.expectedVersion}, observed ${observed}).`;
      if (hermesCronRestoreIdentity) {
        return bailAfterHermesCronRestoreFailure(
          sandboxName,
          backupManifest,
          `${detail} Hermes cron dispatch remains drained.`,
          "Replacement agent version did not match the authoritative rebuild target.",
          bail,
          mcpBridgeRestoreUnverified ? () => printMcpRestoreRecovery(sandboxName, true) : undefined,
        );
      }
      console.error(detail);
      bail("Replacement agent version did not match the authoritative rebuild target.");
      return;
    }
    verifiedAgentVersion = rebuiltVersion.sandboxVersion;
  }
  if (targetAgentName === "hermes") {
    const mutableConfigVerification = inspectMutableHermesConfigPerms(sandboxName);
    mutableConfigPermissionsVerified = mutableConfigVerification.verified;
    if (mutableConfigPermissionsVerified) {
      log("Verified the rebuilt Hermes mutable config posture");
    } else {
      log(
        `Hermes mutable config posture was not verified: ${mutableConfigVerification.errors.join("; ")}`,
      );
    }
  }
  if (hermesCronRestoreIdentity) {
    const replacementIdentity = hermesGatewayVerification.replacementIdentity;
    if (
      hermesGatewayRestoreUnverified ||
      hermesGatewayRestoreState === "not-applicable" ||
      !replacementIdentity
    ) {
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because the replacement gateway was not verified.",
        "Hermes cron restore validation failed; dispatch was not re-enabled.",
        bail,
        mcpBridgeRestoreUnverified ? () => printMcpRestoreRecovery(sandboxName, true) : undefined,
      );
    }
    if (mcpBridgeRestoreUnverified) {
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because managed MCP restoration was not verified.",
        "Hermes MCP restoration failed; cron dispatch was not re-enabled.",
        bail,
        () => printMcpRestoreRecovery(sandboxName, true),
      );
    }
    let completedIdentity: HermesCronRestoreIdentity;
    try {
      completedIdentity = completeHermesCronRestoreAfterGatewayReplacement(
        sandboxName,
        hermesCronRestoreIdentity,
        replacementIdentity,
      );
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : String(error);
      if (isHermesCronRestoreDrainMarkerRollbackFailure(error)) {
        return bailAfterHermesCronRestoreFailure(
          sandboxName,
          backupManifest,
          `  Hermes cron restore release rollback failed: ${errorDetail}. Dispatch state is unverified, but root-owned recovery state was preserved; run recovery immediately so it can reacquire the gate and validate restored cron state.`,
          "Hermes cron restore release state requires immediate recovery.",
          bail,
        );
      }
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        `  Hermes cron restore could not validate the replacement gateway and reactivate dispatch: ${errorDetail}`,
        "Hermes cron restore validation failed; dispatch was not re-enabled.",
        bail,
      );
    }
    log(
      `Hermes cron restore gate released: pid=${String(completedIdentity.pid)}, startTime=${String(completedIdentity.start_time)}`,
    );
  }
  if (hermesGatewayRestoreState === "healthy") {
    console.log(`  ${G}\u2713${R} Hermes gateway restarted and verified after state restore`);
  } else if (hermesGatewayRestoreState === "recovered") {
    console.log(`  ${G}\u2713${R} Hermes gateway recovered after state restore`);
  }
  registry.updateSandbox(sandboxName, {
    agentVersion: verifiedAgentVersion,
  });
  log(`Registry updated: agentVersion=${agentDef.expectedVersion}`);

  if (
    !(await ensureMessagingHostForwardAfterRebuild(
      sandboxName,
      effectiveMessagingPlan,
      mcpRuntimeSelection,
    ))
  ) {
    messagingHostForwardUnverified = true;
  }
  console.log("");
  const genericPostRestoreComplete = postRestoreCompleted({
    hermesGatewayRestoreUnverified,
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified: false,
    mutablePermsRepairUnverified: false,
    restoreSucceeded,
  });
  if (agentDef.runtime?.kind === "terminal" && genericPostRestoreComplete) {
    // Terminal-agent config is materialized by the exact replacement image,
    // outside the restored user-state contract. Exact recreated identity plus
    // successful restore and generic post-restore checks therefore prove that
    // an older locked config posture did not cross the rebuild boundary.
    mutableConfigPermissionsVerified = true;
    log(`Verified the rebuilt ${targetAgentName} terminal-agent mutable posture`);
  }
  const postRestoreComplete = genericPostRestoreComplete && mutableConfigPermissionsVerified;
  if (postRestoreComplete) {
    console.log(`  ${G}✓${R} Sandbox '${sandboxName}' rebuild completed`);
    if (versionCheck.expectedVersion) {
      console.log(`    Now running: ${rebuiltAgentName} v${versionCheck.expectedVersion}`);
    }
  } else {
    console.log(
      `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but some post-restore steps were incomplete`,
    );
    if (!restoreSucceeded && backupManifest) {
      console.log(
        `    State restore was incomplete \u2014 backup available at: ${backupManifest.backupPath}`,
      );
    }
    if (messagingHostForwardUnverified) {
      console.log(
        `    Messaging webhook forward was not verified \u2014 resolve the forwarding error, then run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to finish recovery`,
      );
    }
    printHermesGatewayRestoreRecovery(sandboxName, hermesGatewayRestoreState);
    printMcpRestoreRecovery(sandboxName, mcpBridgeRestoreUnverified);
  }
  printHermesOperatorConfigRestoreReport(targetAgentName, hermesOperatorConfigRestore);
  if (!restoreSucceeded) {
    console.error(
      `  State recovery remains incomplete. Correct the restore error, then run \`${CLI_NAME} ${sandboxName} rebuild\` again.`,
    );
    bail(`State restore remained incomplete after rebuilding '${sandboxName}'.`);
    return;
  }
  if (
    targetAgentName === "hermes" &&
    (hermesGatewayRestoreUnverified || mcpBridgeRestoreUnverified)
  ) {
    bail(`Hermes post-restore verification failed for '${sandboxName}'.`);
    return;
  }
  if (messagingHostForwardUnverified) {
    if (backupManifest) console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
    console.error(
      `  Messaging forwarding for '${sandboxName}' must be verified before rebuild completion.`,
    );
    await input.recheckMessagingConflicts?.(mcpRuntimeSelection, bail);
    bail(`Messaging webhook forwarding remained unverified for '${sandboxName}'.`);
    return;
  }
  if (preparedBackupRecovery && !postRestoreComplete) {
    bail(
      `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
    );
    return;
  }
  printHermesApiTokenChangeNotice(sandboxName, targetAgentName);
  return { mutableConfigPermissionsVerified };
}
