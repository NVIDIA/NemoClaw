// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import * as shields from "../../shields";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";

interface RebuildShieldsResetDeps {
  clearShieldsState?: typeof shields.clearShieldsState;
}

export function resetRebuildShieldsStateAfterRecreate(
  sandboxName: string,
  recoveryRecreate: boolean,
  deps: RebuildShieldsResetDeps = {},
): void {
  if (!recoveryRecreate) return;
  (deps.clearShieldsState ?? shields.clearShieldsState)(sandboxName);
}

export interface RebuildPostRestoreFinalizationOptions {
  sandboxName: string;
  agentExpectedVersion: string | null;
  reportedVersion: string | null;
  rebuiltAgentName: string;
  restoredPresets: string[];
  failedPresets: string[];
  rebuildMessagingPlan: SandboxMessagingPlan | null;
  restoreSucceeded: boolean;
  mutablePermsRepairUnverified: boolean;
  mutableConfigHashRefreshUnverified: boolean;
  staleRecovery: boolean;
  backup: { readonly backupPath: string } | null;
  recoveryRecreate: boolean;
  staleSandboxWasLocked: boolean;
  preparedBackupRecovery: boolean;
  relockShields: () => boolean;
  log: (message: string) => void;
  bail: (message: string, code?: number) => never;
}

interface RebuildPostRestoreFinalizationDeps {
  updateSandbox?: typeof registry.updateSandbox;
  ensureMessagingHostForward?: typeof ensureMessagingHostForwardAfterRebuild;
  writeLine?: (message: string) => void;
}

export interface RebuildPostRestoreFinalizationResult {
  postRestoreComplete: boolean;
  messagingHostForwardUnverified: boolean;
}

/**
 * Reconcile rebuilt state and report its recovery posture in one fixed order.
 * Keep this boundary after all restore/migration work: the restored preset set
 * is authoritative, shields must relock before host forwarding is verified,
 * and prepared recovery must fail closed on any unverified post-restore step.
 */
export function finalizeRebuildPostRestore(
  options: RebuildPostRestoreFinalizationOptions,
  deps: RebuildPostRestoreFinalizationDeps = {},
): RebuildPostRestoreFinalizationResult {
  const updateSandbox = deps.updateSandbox ?? registry.updateSandbox;
  const ensureMessagingHostForward =
    deps.ensureMessagingHostForward ?? ensureMessagingHostForwardAfterRebuild;
  const writeLine = deps.writeLine ?? console.log;

  // Source-of-truth reconciliation for `policies`:
  //
  // - Invalid state: `registry.policies` retained a preset name after the
  //   reapply loop pruned it (disabled messaging channel) or skipped it
  //   (failed `applyPreset`), so `policy-list` showed a marker for a preset
  //   whose rules were absent from the gateway.
  // - Source boundary: `policies.applyPreset` only appends to
  //   `registry.policies`; nothing else writes the canonical post-rebuild
  //   set. The reapply loop is the only place that knows which presets were
  //   actually reapplied.
  // - Source-fix constraint: this must run after the reapply loop and use the
  //   successfully restored subset, not the saved set (which still includes
  //   failures).
  // - Regression tests: `rebuild-flow.test.ts` asserts the successful subset
  //   reaches `registry.updateSandbox`; this module's tests also pin the
  //   reconciliation and finalization order.
  // - Removal condition: drop this once `applyPreset` writes the canonical
  //   post-apply set itself (replacing its append-only contract), making this
  //   rebuild reconciliation redundant.
  updateSandbox(options.sandboxName, {
    agentVersion: options.agentExpectedVersion || null,
    policies: options.restoredPresets,
  });
  options.log(
    `Registry updated: agentVersion=${options.agentExpectedVersion}, policies=[${options.restoredPresets.join(",")}]`,
  );

  if (!options.relockShields()) {
    return options.bail("Failed to re-apply shields lockdown.");
  }

  const messagingHostForwardUnverified = !ensureMessagingHostForward(
    options.sandboxName,
    options.rebuildMessagingPlan,
  );
  const policyPresetRestoreIncomplete = options.failedPresets.length > 0;
  const postRestoreComplete =
    options.restoreSucceeded &&
    !options.mutablePermsRepairUnverified &&
    !options.mutableConfigHashRefreshUnverified &&
    !messagingHostForwardUnverified &&
    !policyPresetRestoreIncomplete;

  writeLine("");
  if (postRestoreComplete) {
    writeLine(`  ${G}\u2713${R} Sandbox '${options.sandboxName}' rebuilt successfully`);
    if (options.staleRecovery && !options.backup) {
      writeLine(
        `    ${D}Recovered from a stale registry entry \u2014 no prior workspace state was available to restore.${R}`,
      );
    }
    if (options.reportedVersion) {
      writeLine(`    Now running: ${options.rebuiltAgentName} v${options.reportedVersion}`);
    }
  } else {
    writeLine(
      `  ${YW}\u26a0${R} Sandbox '${options.sandboxName}' rebuilt but some post-restore steps were incomplete`,
    );
    if (!options.restoreSucceeded && options.backup) {
      writeLine(
        `    State restore was incomplete \u2014 backup available at: ${options.backup.backupPath}`,
      );
    }
    if (options.mutablePermsRepairUnverified) {
      writeLine(
        `    Mutable config permissions were not verified \u2014 run \`${CLI_NAME} ${options.sandboxName} doctor --fix\` to restore the OpenClaw config permission contract`,
      );
    }
    if (options.mutableConfigHashRefreshUnverified) {
      writeLine(
        `    Mutable OpenClaw config hash was not refreshed \u2014 restart the sandbox or re-run \`${CLI_NAME} ${options.sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (messagingHostForwardUnverified) {
      writeLine(
        `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${options.sandboxName} connect\` after resolving the port conflict`,
      );
    }
    if (policyPresetRestoreIncomplete) {
      writeLine(
        `    Policy presets failed to reapply: ${options.failedPresets.join(", ")} \u2014 re-apply manually with \`${CLI_NAME} ${options.sandboxName} policy-add\``,
      );
    }
  }

  if (options.recoveryRecreate && options.staleSandboxWasLocked) {
    writeLine(
      `    ${YW}\u26a0${R} Shields were previously enabled but the recreated sandbox starts unlocked \u2014 run \`${CLI_NAME} ${options.sandboxName} shields up\` to restore lockdown.`,
    );
  }
  if (options.preparedBackupRecovery && !postRestoreComplete) {
    options.bail(
      `Prepared backup recovery for '${options.sandboxName}' completed with unverified post-restore state.`,
    );
  }

  return { postRestoreComplete, messagingHostForwardUnverified };
}
