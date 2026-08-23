// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import { normalizePolicyTierName } from "../../onboard/policy-tier-suppression";
import { BASELINE_EXCLUSION_SUPPORT_IMPACT } from "../../policy/baseline-exclusion";
import type * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxExecCommand } from "./process-recovery";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import {
  refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
  verifyFinalMutableOpenClawConfigHash,
} from "./rebuild-config-hash";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  completeHermesCronRestoreAfterGatewayReplacement,
  type HermesCronRestoreIdentity,
  isHermesCronRestoreDrainMarkerRollbackFailure,
  printHermesGatewayRestoreRecovery,
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";
import {
  type McpRebuildPreparation,
  postRestoreCompleted,
  printMcpRestoreRecovery,
  restoreMcpAfterRebuild,
} from "./rebuild-mcp-phase";
import { reapplyMessagingManifestAfterOpenClawDoctor } from "./rebuild-messaging-phase";
import { reconcileStalePinnedSessionModelsAfterRebuild } from "./reconcile-session-models";

export {
  type HermesCronRestoreIdentity,
  HermesCronRestoreIncompleteError,
  recoverHermesCronRestore,
  runHermesCronRestoreTransaction,
} from "./rebuild-hermes-post-restore";

const OPENCLAW_DOCTOR_TIMEOUT_MS = 5 * 60_000;

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
  sandboxEntry: RebuildSandboxEntry;
  targetAgentName: string;
  messagingPlan: SandboxMessagingPlan | null;
  backupManifest: RebuildBackupManifest;
  mcpEntries: McpRebuildPreparation["entries"];
  restoreSucceeded: boolean;
  hermesCronRestoreIdentity?: HermesCronRestoreIdentity;
  backupWasForceSkipped: boolean;
  failedPresets: string[];
  finalBuiltinPresets: string[];
  failedPresetRemovals: string[];
  policyPresetReconciliationVerified: boolean;
  staleRecovery: boolean;
  recoveryRecreate: boolean;
  preparedBackupRecovery: boolean;
  staleSandboxWasLocked: boolean;
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
  log: RebuildLog;
  bail: RebuildBail;
}

interface SuccessfulRebuildSummaryInput {
  sandboxName: string;
  backupManifest: RebuildBackupManifest;
  backupWasForceSkipped: boolean;
  staleRecovery: boolean;
  rebuiltAgentName: string;
  expectedVersion: string | null;
}

/** Disclose carried-over baseline exclusions and their support impact after a rebuild. */
export function printBaselineExclusionsRebuildSummary(
  sandboxName: string,
  writeLine: (message: string) => void = console.log,
): void {
  const exclusions = registry.getBaselineExclusions(sandboxName);
  if (exclusions.length === 0) return;
  const keys = exclusions.map((exclusion) => exclusion.key).join(", ");
  writeLine(
    `    Baseline exclusions carried over: ${keys} \u2014 ${BASELINE_EXCLUSION_SUPPORT_IMPACT}`,
  );
}

export function printSuccessfulRebuildSummary(
  input: SuccessfulRebuildSummaryInput,
  writeLine: (message: string) => void = console.log,
): void {
  writeLine(`  ${G}\u2713${R} Sandbox '${input.sandboxName}' rebuilt successfully`);
  if (input.backupWasForceSkipped) {
    writeLine(
      `    ${YW}\u26a0${R} Backup was skipped via --force after a total backup failure \u2014 prior workspace state was not preserved.`,
    );
  } else if (input.staleRecovery && !input.backupManifest) {
    writeLine(
      `    ${D}Recovered from a stale registry entry \u2014 no prior workspace state was available to restore.${R}`,
    );
  }
  if (input.expectedVersion) {
    writeLine(`    Now running: ${input.rebuiltAgentName} v${input.expectedVersion}`);
  }
  printBaselineExclusionsRebuildSummary(input.sandboxName, writeLine);
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

export function resolveRestoredPolicyRegistryState(
  sandboxEntry: Pick<RebuildSandboxEntry, "policyPresetsFinalized">,
  restoredBuiltinPresets: readonly string[],
  failedPresets: readonly string[],
  policyPresetReconciliationVerified = true,
): { policies: string[]; policyPresetsFinalized: true | undefined } {
  return {
    policies: [...new Set(restoredBuiltinPresets)],
    policyPresetsFinalized:
      sandboxEntry.policyPresetsFinalized === true &&
      failedPresets.length === 0 &&
      policyPresetReconciliationVerified
        ? true
        : undefined,
  };
}

/**
 * Repair agent state, restore MCP/forwarding, reconcile the registry, and report
 * the final transaction result. Boundary coverage: rebuild-flow.test.ts and
 * rebuild-config-hash.test.ts cover the complete/incomplete post-restore paths;
 * rebuild-post-restore-phase.test.ts covers the relock-then-forward order and
 * the shields and forwarding recovery reports.
 */
export async function runRebuildPostRestorePhase(
  input: RebuildPostRestorePhaseInput,
): Promise<void> {
  const {
    sandboxName,
    sandboxEntry: sb,
    targetAgentName,
    messagingPlan,
    backupManifest,
    mcpEntries,
    restoreSucceeded,
    hermesCronRestoreIdentity,
    backupWasForceSkipped,
    failedPresets,
    finalBuiltinPresets,
    failedPresetRemovals,
    policyPresetReconciliationVerified,
    staleRecovery,
    recoveryRecreate,
    preparedBackupRecovery,
    staleSandboxWasLocked,
    versionCheck,
    relockShieldsIfNeeded,
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
    recreatedRuntimeAgentName !== targetAgentName
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
  let mutablePermsRepairUnverified = false;
  let mutableConfigHashRefreshUnverified = false;
  let finalMutableConfigHashUnverified = false;
  let messagingHostForwardUnverified = false;
  const policyPresetRestoreIncomplete =
    failedPresets.length > 0 ||
    failedPresetRemovals.length > 0 ||
    !policyPresetReconciliationVerified;

  if (targetAgentName === "openclaw") {
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxExecCommand(
      sandboxName,
      "openclaw doctor --fix",
      OPENCLAW_DOCTOR_TIMEOUT_MS,
      { allowLocalDockerFallback: false },
    );
    log(`doctor --fix: exit=${doctorResult?.status ?? "unverified"}`);
    if (doctorResult === null) {
      console.log(`  ${D}Post-upgrade structure repair completion was not verified${R}`);
      bail("OpenClaw post-upgrade structure repair completion was not verified after rebuild.");
      return;
    }
    if (doctorResult.status !== 0) {
      console.log(
        `  ${D}Post-upgrade structure repair failed (doctor returned ${doctorResult.status})${R}`,
      );
      bail("OpenClaw post-upgrade structure repair failed during rebuild.");
      return;
    }
    console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);

    // #7102: clear stale per-session pinned models left over from an
    // `inference set` before this rebuild, while the gateway is still down.
    reconcileStalePinnedSessionModelsAfterRebuild(sandboxName, log);

    await reapplyMessagingManifestAfterOpenClawDoctor(sandboxName, messagingPlan, log);

    log("Restoring mutable OpenClaw config permissions after post-restore config writes");
    let permRepair: ReturnType<typeof shields.repairMutableConfigPerms> | null = null;
    try {
      permRepair = shields.repairMutableConfigPerms(sandboxName);
    } catch (error) {
      mutablePermsRepairUnverified = true;
      console.error(
        `  ${YW}\u26a0${R} Mutable config permission repair errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (permRepair === null) {
      // The thrown error was reported above.
    } else if (!permRepair.applied) {
      if (permRepair.skipReason === "unreadable") {
        mutablePermsRepairUnverified = true;
        console.error(
          `  ${YW}\u26a0${R} Mutable config permissions not restored: ${permRepair.reason}`,
        );
      } else {
        log(`Mutable config permission repair skipped: ${permRepair.reason}`);
      }
    } else if (permRepair.verified) {
      console.log(`  ${G}\u2713${R} Mutable config permissions restored`);
    } else {
      mutablePermsRepairUnverified = true;
      console.error(
        `  ${YW}\u26a0${R} Mutable config permission repair incomplete: ${permRepair.errors.join("; ")}`,
      );
    }
  }

  // Restart before restoring MCP. The Hermes MCP transaction performs an
  // acknowledged reload of its own; restarting afterwards would replace the
  // only runtime whose managed MCP configuration was proven to have loaded.
  const hermesGatewayRestartState = restartHermesGatewayAfterStateRestore(
    sandboxName,
    targetAgentName,
  );
  const mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(sandboxName, mcpEntries));
  if (targetAgentName === "openclaw" && mcpBridgeRestoreUnverified) {
    mutableConfigHashRefreshUnverified = true;
  } else if (targetAgentName === "openclaw") {
    log("Refreshing mutable OpenClaw config hash after MCP restoration");
    if (!refreshMutableOpenClawConfigHashAfterPostRestoreWrites(sandboxName, log)) {
      mutableConfigHashRefreshUnverified = true;
    } else if (!verifyFinalMutableOpenClawConfigHash(sandboxName, log)) {
      finalMutableConfigHashUnverified = true;
    }
  }
  const hermesGatewayVerification = hermesCronRestoreIdentity
    ? verifyHermesGatewayAfterStateRestoreForCronGate(
        sandboxName,
        targetAgentName,
        hermesGatewayRestartState,
        hermesCronRestoreIdentity,
      )
    : {
        state: verifyHermesGatewayAfterStateRestore(
          sandboxName,
          targetAgentName,
          hermesGatewayRestartState,
        ),
        replacementIdentity: undefined,
      };
  const hermesGatewayRestoreState = hermesGatewayVerification.state;
  const hermesGatewayRestoreUnverified = hermesGatewayRestoreState === "unverified";
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
  const { policies: restoredBuiltinPresets, policyPresetsFinalized } =
    resolveRestoredPolicyRegistryState(
      {
        policyPresetsFinalized: sb.policyPresetsFinalized,
      },
      finalBuiltinPresets,
      failedPresets,
      policyPresetReconciliationVerified,
    );
  registry.updateSandbox(sandboxName, {
    agentVersion: agentDef.expectedVersion || null,
    policies: restoredBuiltinPresets,
    policyTier: normalizePolicyTierName(sb.policyTier),
    policyPresetsFinalized,
  });
  log(
    `Registry updated: agentVersion=${agentDef.expectedVersion}, policies=[${restoredBuiltinPresets.join(",")}], policyPresetsFinalized=${String(policyPresetsFinalized === true)}`,
  );

  if (!relockShieldsIfNeeded(true)) {
    bail("Failed to re-apply shields lockdown.");
    return;
  }
  if (!ensureMessagingHostForwardAfterRebuild(sandboxName, messagingPlan)) {
    messagingHostForwardUnverified = true;
  }
  if (
    targetAgentName === "openclaw" &&
    !mcpBridgeRestoreUnverified &&
    !mutableConfigHashRefreshUnverified &&
    !verifyFinalMutableOpenClawConfigHash(sandboxName, log)
  ) {
    finalMutableConfigHashUnverified = true;
  }

  console.log("");
  const postRestoreComplete = postRestoreCompleted({
    hermesGatewayRestoreUnverified,
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified:
      mutableConfigHashRefreshUnverified || finalMutableConfigHashUnverified,
    mutablePermsRepairUnverified,
    policyPresetRestoreIncomplete,
    restoreSucceeded,
  });
  if (postRestoreComplete) {
    printSuccessfulRebuildSummary({
      sandboxName,
      backupManifest,
      backupWasForceSkipped,
      staleRecovery,
      rebuiltAgentName,
      expectedVersion: versionCheck.expectedVersion,
    });
  } else {
    console.log(
      `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but some post-restore steps were incomplete`,
    );
    if (!restoreSucceeded && backupManifest) {
      console.log(
        `    State restore was incomplete \u2014 backup available at: ${backupManifest.backupPath}`,
      );
    }
    if (mutablePermsRepairUnverified) {
      console.log(
        `    Mutable config permissions were not verified \u2014 run \`${CLI_NAME} ${sandboxName} doctor --fix\` to restore the OpenClaw config permission contract`,
      );
    }
    if (mutableConfigHashRefreshUnverified) {
      console.log(
        `    Mutable OpenClaw config hash was not refreshed \u2014 restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (finalMutableConfigHashUnverified && !mutableConfigHashRefreshUnverified) {
      console.log(
        `    Final OpenClaw configuration hash verification failed after post-restore finalization \u2014 restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (messagingHostForwardUnverified) {
      console.log(
        `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
      );
    }
    printHermesGatewayRestoreRecovery(sandboxName, hermesGatewayRestoreState);
    printMcpRestoreRecovery(sandboxName, mcpBridgeRestoreUnverified);
    printBaselineExclusionsRebuildSummary(sandboxName);
    if (policyPresetRestoreIncomplete) {
      if (failedPresets.length > 0) {
        console.log(
          `    Policy presets failed to reapply: ${failedPresets.join(", ")} \u2014 re-apply manually with \`${CLI_NAME} ${sandboxName} policy add\``,
        );
      }
      if (failedPresetRemovals.length > 0 || !policyPresetReconciliationVerified) {
        console.log(
          `    Exact live policy reconciliation was incomplete${failedPresetRemovals.length > 0 ? `; remove failed: ${failedPresetRemovals.join(", ")}` : ""} \u2014 reconcile manually with \`${CLI_NAME} ${sandboxName} policy add\` or \`${CLI_NAME} ${sandboxName} policy remove\``,
        );
      }
    }
  }
  if (recoveryRecreate && staleSandboxWasLocked) {
    console.log(
      `    ${YW}\u26a0${R} Shields were previously enabled but the recreated sandbox starts unlocked \u2014 run \`${CLI_NAME} ${sandboxName} shields up\` to restore lockdown.`,
    );
  }
  if (failedPresetRemovals.length > 0 || !policyPresetReconciliationVerified) {
    bail(`Rebuild completed with unverified live policy reconciliation for '${sandboxName}'.`);
    return;
  }
  if (
    targetAgentName === "openclaw" &&
    !mcpBridgeRestoreUnverified &&
    (mutableConfigHashRefreshUnverified || finalMutableConfigHashUnverified)
  ) {
    bail("OpenClaw config integrity verification failed after rebuild.");
    return;
  }
  if (
    targetAgentName === "hermes" &&
    (hermesGatewayRestoreUnverified || mcpBridgeRestoreUnverified)
  ) {
    bail(`Hermes post-restore verification failed for '${sandboxName}'.`);
    return;
  }
  if (preparedBackupRecovery && !postRestoreComplete) {
    bail(
      `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
    );
    return;
  }
  printHermesApiTokenChangeNotice(sandboxName, targetAgentName);
}
