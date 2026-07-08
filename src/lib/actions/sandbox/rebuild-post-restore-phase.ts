// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import { normalizePolicyTierName } from "../../onboard/policy-tier-suppression";
import type * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxCommand } from "./process-recovery";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import { refreshMutableOpenClawConfigHashAfterPostRestoreWrites } from "./rebuild-config-hash";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  type McpRebuildPreparation,
  postRestoreCompleted,
  printMcpRestoreRecovery,
  restoreMcpAfterRebuild,
} from "./rebuild-mcp-phase";
import { reapplyMessagingManifestAfterOpenClawDoctor } from "./rebuild-messaging-phase";

export interface RebuildPostRestorePhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  messagingPlan: SandboxMessagingPlan | null;
  backupManifest: RebuildBackupManifest;
  mcpEntries: McpRebuildPreparation["entries"];
  restoreSucceeded: boolean;
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
 * rebuild-config-hash.test.ts cover the complete/incomplete post-restore paths.
 */
export async function runRebuildPostRestorePhase(
  input: RebuildPostRestorePhaseInput,
): Promise<void> {
  const {
    sandboxName,
    sandboxEntry: sb,
    messagingPlan,
    backupManifest,
    mcpEntries,
    restoreSucceeded,
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
  const rebuiltAgent = agentRuntime.getSessionAgent(sandboxName);
  const rebuiltAgentName = agentRuntime.getAgentDisplayName(rebuiltAgent);
  const agentDef = rebuiltAgent ? loadAgent(rebuiltAgent.name) : loadAgent("openclaw");
  let mutablePermsRepairUnverified = false;
  let mutableConfigHashRefreshUnverified = false;
  let messagingHostForwardUnverified = false;
  const policyPresetRestoreIncomplete =
    failedPresets.length > 0 ||
    failedPresetRemovals.length > 0 ||
    !policyPresetReconciliationVerified;

  if (agentDef.name === "openclaw") {
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
    log(
      `doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`,
    );
    if (doctorResult && doctorResult.status === 0) {
      console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);
    } else {
      console.log(
        `  ${D}Post-upgrade structure check skipped (doctor returned ${doctorResult?.status ?? "null"})${R}`,
      );
    }

    await reapplyMessagingManifestAfterOpenClawDoctor(sandboxName, messagingPlan, log);
    log("Refreshing mutable OpenClaw config hash after post-restore config writes");
    if (!refreshMutableOpenClawConfigHashAfterPostRestoreWrites(sandboxName, log)) {
      mutableConfigHashRefreshUnverified = true;
    }

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

  const mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(sandboxName, mcpEntries));
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

  console.log("");
  const postRestoreComplete = postRestoreCompleted({
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified,
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
    if (messagingHostForwardUnverified) {
      console.log(
        `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
      );
    }
    printMcpRestoreRecovery(sandboxName, mcpBridgeRestoreUnverified);
    if (policyPresetRestoreIncomplete) {
      if (failedPresets.length > 0) {
        console.log(
          `    Policy presets failed to reapply: ${failedPresets.join(", ")} \u2014 re-apply manually with \`${CLI_NAME} ${sandboxName} policy-add\``,
        );
      }
      if (failedPresetRemovals.length > 0 || !policyPresetReconciliationVerified) {
        console.log(
          `    Exact live policy reconciliation was incomplete${failedPresetRemovals.length > 0 ? `; remove failed: ${failedPresetRemovals.join(", ")}` : ""} \u2014 reconcile manually with \`${CLI_NAME} ${sandboxName} policy-add\` or \`${CLI_NAME} ${sandboxName} policy-remove\``,
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
  if (preparedBackupRecovery && !postRestoreComplete) {
    bail(
      `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
    );
  }
}
