// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import { normalizePolicyTierName } from "../../onboard/policy-tier-suppression";
import type * as sandboxVersion from "../../sandbox/version";
import { redactFull } from "../../security/redact";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxCommand } from "./process-recovery";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import { refreshMutableOpenClawConfigHashAfterPostRestoreWrites } from "./rebuild-config-hash";
import type { RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  type McpRebuildPreparation,
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
  failedPresets: string[];
  finalBuiltinPresets: string[];
  failedPresetRemovals: string[];
  policyPresetReconciliationVerified: boolean;
  staleRecovery: boolean;
  recoveryRecreate: boolean;
  staleSandboxWasLocked: boolean;
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>;
  relockShieldsIfNeeded: (sandboxStillExists: boolean) => boolean;
  log: RebuildLog;
}

export type RebuildPostRestoreRequiredFinding =
  | "STATE_RESTORE_INCOMPLETE"
  | "MUTABLE_CONFIG_PERMISSIONS_UNVERIFIED"
  | "MUTABLE_CONFIG_HASH_UNVERIFIED"
  | "MCP_BRIDGE_RESTORE_UNVERIFIED"
  | "POLICY_PRESET_RESTORE_INCOMPLETE"
  | "POLICY_RECONCILIATION_UNVERIFIED"
  | "REGISTRY_RECONCILIATION_UNVERIFIED"
  | "SHIELDS_RELOCK_UNVERIFIED"
  | "MESSAGING_HOST_FORWARD_UNVERIFIED";

export type RebuildPostRestoreAdvisoryFinding =
  | "OPENCLAW_DOCTOR_UNVERIFIED"
  | "RECOVERY_SHIELDS_UNLOCKED";

export interface RebuildPostRestoreVerification {
  complete: boolean;
  required: RebuildPostRestoreRequiredFinding[];
  advisory: RebuildPostRestoreAdvisoryFinding[];
}

interface RebuildPostRestoreObservations {
  restoreSucceeded: boolean;
  mutablePermsVerified: boolean;
  mutableConfigHashVerified: boolean;
  mcpBridgeRestoreVerified: boolean;
  policyPresetRestoreVerified: boolean;
  policyReconciliationVerified: boolean;
  registryReconciliationVerified: boolean;
  shieldsRelocked: boolean;
  messagingHostForwardVerified: boolean;
  openClawDoctorVerified: boolean;
  recoveryShieldsUnlocked: boolean;
}

/** Convert phase observations into the only contract allowed to gate completion. */
export function verifyRebuildPostRestore(
  observations: RebuildPostRestoreObservations,
): RebuildPostRestoreVerification {
  const required: RebuildPostRestoreRequiredFinding[] = [];
  const advisory: RebuildPostRestoreAdvisoryFinding[] = [];
  if (!observations.restoreSucceeded) required.push("STATE_RESTORE_INCOMPLETE");
  if (!observations.mutablePermsVerified) {
    required.push("MUTABLE_CONFIG_PERMISSIONS_UNVERIFIED");
  }
  if (!observations.mutableConfigHashVerified) {
    required.push("MUTABLE_CONFIG_HASH_UNVERIFIED");
  }
  if (!observations.mcpBridgeRestoreVerified) required.push("MCP_BRIDGE_RESTORE_UNVERIFIED");
  if (!observations.policyPresetRestoreVerified) {
    required.push("POLICY_PRESET_RESTORE_INCOMPLETE");
  }
  if (!observations.policyReconciliationVerified) {
    required.push("POLICY_RECONCILIATION_UNVERIFIED");
  }
  if (!observations.registryReconciliationVerified) {
    required.push("REGISTRY_RECONCILIATION_UNVERIFIED");
  }
  if (!observations.shieldsRelocked) required.push("SHIELDS_RELOCK_UNVERIFIED");
  if (!observations.messagingHostForwardVerified) {
    required.push("MESSAGING_HOST_FORWARD_UNVERIFIED");
  }
  if (!observations.openClawDoctorVerified) advisory.push("OPENCLAW_DOCTOR_UNVERIFIED");
  if (observations.recoveryShieldsUnlocked) advisory.push("RECOVERY_SHIELDS_UNLOCKED");
  return { complete: required.length === 0, required, advisory };
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
 * Repair and verify rebuilt state, returning the authoritative completion
 * result. The coordinator alone decides whether to retain or complete the
 * durable transaction from this result.
 */
export async function runRebuildPostRestorePhase(
  input: RebuildPostRestorePhaseInput,
): Promise<RebuildPostRestoreVerification> {
  const {
    sandboxName,
    sandboxEntry: sb,
    messagingPlan,
    backupManifest,
    mcpEntries,
    restoreSucceeded,
    failedPresets,
    finalBuiltinPresets,
    failedPresetRemovals,
    policyPresetReconciliationVerified,
    staleRecovery,
    recoveryRecreate,
    staleSandboxWasLocked,
    versionCheck,
    relockShieldsIfNeeded,
    log,
  } = input;
  const rebuiltAgent = agentRuntime.getSessionAgent(sandboxName);
  const rebuiltAgentName = agentRuntime.getAgentDisplayName(rebuiltAgent);
  const agentDef = rebuiltAgent ? loadAgent(rebuiltAgent.name) : loadAgent("openclaw");
  let mutablePermsRepairUnverified = false;
  let mutableConfigHashRefreshUnverified = false;
  let openClawDoctorVerified = true;

  if (agentDef.name === "openclaw") {
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxCommand(sandboxName, "openclaw doctor --fix");
    log(
      `doctor --fix: exit=${doctorResult?.status}, stdout=${(doctorResult?.stdout || "").substring(0, 200)}`,
    );
    if (doctorResult && doctorResult.status === 0) {
      console.log(`  ${G}✓${R} Post-upgrade structure check passed`);
    } else {
      openClawDoctorVerified = false;
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
        `  ${YW}⚠${R} Mutable config permission repair errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (permRepair === null) {
      // The thrown error was reported above.
    } else if (!permRepair.applied) {
      if (permRepair.skipReason === "unreadable") {
        mutablePermsRepairUnverified = true;
        console.error(`  ${YW}⚠${R} Mutable config permissions not restored: ${permRepair.reason}`);
      } else {
        log(`Mutable config permission repair skipped: ${permRepair.reason}`);
      }
    } else if (permRepair.verified) {
      console.log(`  ${G}✓${R} Mutable config permissions restored`);
    } else {
      mutablePermsRepairUnverified = true;
      console.error(
        `  ${YW}⚠${R} Mutable config permission repair incomplete: ${permRepair.errors.join("; ")}`,
      );
    }
  }

  const mcpBridgeRestoreVerified = await restoreMcpAfterRebuild(sandboxName, mcpEntries);
  const { policies: restoredBuiltinPresets, policyPresetsFinalized } =
    resolveRestoredPolicyRegistryState(
      { policyPresetsFinalized: sb.policyPresetsFinalized },
      finalBuiltinPresets,
      failedPresets,
      policyPresetReconciliationVerified,
    );
  let registryReconciliationVerified = false;
  try {
    registryReconciliationVerified = registry.updateSandbox(sandboxName, {
      agentVersion: agentDef.expectedVersion || null,
      policies: restoredBuiltinPresets,
      policyTier: normalizePolicyTierName(sb.policyTier),
      policyPresetsFinalized,
    });
  } catch (error) {
    // Source-of-truth boundary review:
    // - Invalid state: the replacement is live while its registry metadata is
    //   absent or stale, so the transaction must not be marked completed.
    // - Source boundary: registry.updateSandbox owns the atomic registry write;
    //   post-restore cannot safely reconstruct or bypass a failed write.
    // - Source-fix constraint: retain replacement_created and retry the same
    //   authoritative update instead of introducing a second registry writer.
    // - Regression evidence: rebuild-transaction-finalization-boundary.test.ts
    //   covers false and throwing updates, redacted cause, guidance, and
    //   durable failure.
    // - Removal condition: remove this adapter only when the registry boundary
    //   returns a typed failure carrying equivalent redacted diagnostics.
    console.error(
      `  ${YW}⚠${R} Registry reconciliation failed: ${redactFull(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (registryReconciliationVerified) {
    log(
      `Registry updated: agentVersion=${agentDef.expectedVersion}, policies=[${restoredBuiltinPresets.join(",")}], policyPresetsFinalized=${String(policyPresetsFinalized === true)}`,
    );
  }

  const shieldsRelocked = relockShieldsIfNeeded(true);
  const messagingHostForwardVerified =
    messagingPlan === null ||
    (shieldsRelocked && ensureMessagingHostForwardAfterRebuild(sandboxName, messagingPlan));
  const verification = verifyRebuildPostRestore({
    restoreSucceeded,
    mutablePermsVerified: !mutablePermsRepairUnverified,
    mutableConfigHashVerified: !mutableConfigHashRefreshUnverified,
    mcpBridgeRestoreVerified,
    policyPresetRestoreVerified: failedPresets.length === 0,
    policyReconciliationVerified:
      failedPresetRemovals.length === 0 && policyPresetReconciliationVerified,
    registryReconciliationVerified,
    shieldsRelocked,
    messagingHostForwardVerified,
    openClawDoctorVerified,
    recoveryShieldsUnlocked: recoveryRecreate && staleSandboxWasLocked,
  });

  console.log("");
  if (verification.complete) {
    console.log(`  ${G}✓${R} Sandbox '${sandboxName}' rebuilt successfully`);
    if (staleRecovery && !backupManifest) {
      console.log(
        `    ${D}Recovered from a stale registry entry — no prior workspace state was available to restore.${R}`,
      );
    }
    if (versionCheck.expectedVersion) {
      console.log(`    Now running: ${rebuiltAgentName} v${versionCheck.expectedVersion}`);
    }
  } else {
    console.log(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' rebuilt but some post-restore steps were incomplete`,
    );
    if (verification.required.includes("STATE_RESTORE_INCOMPLETE") && backupManifest) {
      console.log(
        `    State restore was incomplete — backup available at: ${backupManifest.backupPath}`,
      );
    }
    if (verification.required.includes("MUTABLE_CONFIG_PERMISSIONS_UNVERIFIED")) {
      console.log(
        `    Mutable config permissions were not verified — run \`${CLI_NAME} ${sandboxName} doctor --fix\` to restore the OpenClaw config permission contract`,
      );
    }
    if (verification.required.includes("MUTABLE_CONFIG_HASH_UNVERIFIED")) {
      console.log(
        `    Mutable OpenClaw config hash was not refreshed — restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (verification.required.includes("MESSAGING_HOST_FORWARD_UNVERIFIED")) {
      console.log(
        `    Messaging webhook forward was not verified — run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
      );
    }
    printMcpRestoreRecovery(
      sandboxName,
      verification.required.includes("MCP_BRIDGE_RESTORE_UNVERIFIED"),
    );
    if (verification.required.includes("POLICY_PRESET_RESTORE_INCOMPLETE")) {
      console.log(
        `    Policy presets failed to reapply: ${failedPresets.join(", ")} — re-apply manually with \`${CLI_NAME} ${sandboxName} policy-add\``,
      );
    }
    if (verification.required.includes("POLICY_RECONCILIATION_UNVERIFIED")) {
      console.log(
        `    Exact live policy reconciliation was incomplete${failedPresetRemovals.length > 0 ? `; remove failed: ${failedPresetRemovals.join(", ")}` : ""} — reconcile manually with \`${CLI_NAME} ${sandboxName} policy-add\` or \`${CLI_NAME} ${sandboxName} policy-remove\``,
      );
    }
    if (verification.required.includes("REGISTRY_RECONCILIATION_UNVERIFIED")) {
      console.log(`    Rebuilt registry metadata was not verified — retry the rebuild.`);
    }
  }
  if (verification.advisory.includes("RECOVERY_SHIELDS_UNLOCKED")) {
    console.log(
      `    ${YW}⚠${R} Shields were previously enabled but the recreated sandbox starts unlocked — run \`${CLI_NAME} ${sandboxName} shields up\` to restore lockdown.`,
    );
  }
  return verification;
}
