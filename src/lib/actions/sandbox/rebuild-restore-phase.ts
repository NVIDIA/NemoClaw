// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import {
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  OBSERVABILITY_POLICY_BINDING,
} from "../../onboard/observability-policy-presets";
import * as policies from "../../policy";
import * as sandboxState from "../../state/sandbox";
import { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  backupManifest: RebuildBackupManifest;
  policyPresets: string[];
  customPolicies: NonNullable<RebuildSandboxEntry["customPolicies"]>;
  reconcileManagedDcodeObservability: boolean;
  log: RebuildLog;
}

export interface RebuildRestorePhaseResult {
  restoreSucceeded: boolean;
  restoredPresets: string[];
  failedPresets: string[];
  finalPresets: string[];
  finalBuiltinPresets: string[];
  failedPresetRemovals: string[];
  policyPresetReconciliationVerified: boolean;
}

function uniquePresetNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function isManagedObservabilityPreset(name: string): boolean {
  return OBSERVABILITY_POLICY_BINDING.matchesPreset(name);
}

function finalRestoredPresetState(
  restoredBuiltinPresets: readonly string[],
  restoredCustomPresets: readonly string[],
  includeManagedObservability: boolean,
): Pick<RebuildRestorePhaseResult, "finalPresets" | "finalBuiltinPresets"> {
  const finalBuiltinPresets = uniquePresetNames(
    OBSERVABILITY_POLICY_BINDING.setAttribution(
      restoredBuiltinPresets,
      includeManagedObservability,
    ),
  );
  return {
    finalBuiltinPresets,
    finalPresets: uniquePresetNames([...finalBuiltinPresets, ...restoredCustomPresets]),
  };
}

function reconcileFinalManagedObservability(
  sandboxName: string,
  targetManagedObservability: boolean,
  restoredBuiltinPresets: readonly string[],
  restoredCustomPresets: readonly string[],
  failedBuiltinPresets: readonly string[],
  successfulCustomObservabilityContents: readonly string[],
  log: RebuildLog,
): Pick<
  RebuildRestorePhaseResult,
  | "finalPresets"
  | "finalBuiltinPresets"
  | "failedPresetRemovals"
  | "policyPresetReconciliationVerified"
> {
  const customObservabilityStates = successfulCustomObservabilityContents.map((content) =>
    OBSERVABILITY_POLICY_BINDING.inspectContent(sandboxName, content, policies),
  );
  const customObservabilityExpected = successfulCustomObservabilityContents.length > 0;
  const customObservabilityVerified = customObservabilityStates.includes("match");
  if (!targetManagedObservability && customObservabilityVerified) {
    return {
      ...finalRestoredPresetState(restoredBuiltinPresets, restoredCustomPresets, false),
      failedPresetRemovals: [],
      policyPresetReconciliationVerified: true,
    };
  }

  const loadedBinding = OBSERVABILITY_POLICY_BINDING.load(sandboxName, policies);
  const builtinContent = loadedBinding.content;
  if (!builtinContent) {
    log("Could not load managed observability preset content after rebuild restore");
    console.error(
      `  ${YW}\u26a0${R} Could not verify managed observability policy content after restore.`,
    );
    return {
      ...finalRestoredPresetState(
        restoredBuiltinPresets,
        restoredCustomPresets,
        targetManagedObservability,
      ),
      failedPresetRemovals: [],
      policyPresetReconciliationVerified: false,
    };
  }

  const liveBefore = loadedBinding.state;
  const failedPresetRemovals: string[] = [];
  let liveAfter = liveBefore;
  if (!targetManagedObservability && liveBefore === "match") {
    log(`Removing unexpected live preset: ${OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET}`);
    const removal = OBSERVABILITY_POLICY_BINDING.removeExact(
      sandboxName,
      builtinContent,
      policies,
      {
        knownBefore: liveBefore,
        removeOptions: { nonFatal: true },
      },
    );
    if (removal.reportedSuccess !== true) {
      failedPresetRemovals.push(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET);
    }
    if (removal.errorMessage) {
      log(
        `Failed to remove unexpected live preset '${OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET}': ${removal.errorMessage}`,
      );
    }
    liveAfter = removal.after;
  }

  const failedManagedAddition = failedBuiltinPresets.some(isManagedObservabilityPreset);
  const customReplayVerified = !customObservabilityExpected || customObservabilityVerified;
  const managedTargetVerified = targetManagedObservability
    ? liveAfter === "match" || (liveAfter === "absent" && failedManagedAddition)
    : liveAfter === "absent";
  const policyPresetReconciliationVerified =
    failedPresetRemovals.length === 0 && customReplayVerified && managedTargetVerified;
  // Until an exact post-removal read proves absence, preserve attribution for
  // the exact built-in content observed before mutation. Reconciliation stays
  // unverified, but recovery does not forget policy that may still be live.
  const includeManagedObservability =
    liveAfter === "match" ||
    (targetManagedObservability && liveAfter !== "absent") ||
    (!targetManagedObservability && liveBefore === "match" && liveAfter !== "absent");
  const finalPresetState = finalRestoredPresetState(
    restoredBuiltinPresets,
    restoredCustomPresets,
    includeManagedObservability,
  );
  if (!policyPresetReconciliationVerified) {
    const details = [
      ...(!customReplayVerified ? ["custom observability content not verified live"] : []),
      ...(!managedTargetVerified
        ? [`managed observability state ${liveAfter ?? "unavailable"}`]
        : []),
      ...(failedPresetRemovals.length > 0
        ? [`remove failed ${failedPresetRemovals.join(", ")}`]
        : []),
    ];
    console.error(
      `  ${YW}\u26a0${R} Final live policy preset reconciliation is incomplete: ${details.join("; ")}.`,
    );
  }
  log(
    `Final managed observability state: ${liveAfter ?? "unavailable"}; customOwned=${String(customObservabilityVerified)}; builtins=[${finalPresetState.finalBuiltinPresets.join(",")}]; presets=[${finalPresetState.finalPresets.join(",")}]; verified=${String(policyPresetReconciliationVerified)}`,
  );
  return { ...finalPresetState, failedPresetRemovals, policyPresetReconciliationVerified };
}

/**
 * Restore preserved workspace state and gateway-owned built-in policy presets.
 * Boundary coverage: rebuild-flow.test.ts exercises full/partial state restore,
 * stale recovery, successful presets, and incomplete preset recovery reporting.
 */
export function runRebuildRestorePhase(input: RebuildRestorePhaseInput): RebuildRestorePhaseResult {
  const {
    sandboxName,
    backupManifest,
    policyPresets,
    customPolicies,
    reconcileManagedDcodeObservability,
    log,
  } = input;
  let restoreSucceeded = true;
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    log(`Restoring from: ${backupManifest.backupPath} into sandbox: ${sandboxName}`);
    const restore = sandboxState.restoreRecreatedSandboxState(
      sandboxName,
      backupManifest.backupPath,
      { targetAgentType: backupManifest.agentType },
    );
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}${restore.error ? `; error=${restore.error}` : ""}`,
    );
    restoreSucceeded = restore.success;
    if (!restore.success) {
      if (restore.error) {
        console.error(`  Restore blocked: ${restore.error}`);
      }
      console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
      console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
      if (restore.failedFiles.length > 0) {
        console.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
      }
      console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
    } else {
      console.log(
        `  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    }
  }

  const restoredBuiltinPresets: string[] = [];
  const restoredCustomPresets: string[] = [];
  const failedPresets: string[] = [];
  const failedBuiltinPresets: string[] = [];
  const successfulCustomObservabilityContents: string[] = [];
  const customPolicyNames = new Set(customPolicies.map((entry) => entry.name));
  const replayableCustomPolicies = customPolicies.filter(
    (entry) => entry.sourcePath !== MCP_BRIDGE_POLICY_SOURCE,
  );
  const builtinPolicyPresets = policyPresets.filter((name) => !customPolicyNames.has(name));
  const targetManagedObservability = builtinPolicyPresets.some(isManagedObservabilityPreset);
  if (builtinPolicyPresets.length > 0 || replayableCustomPolicies.length > 0) {
    console.log("");
    console.log("  Restoring policy presets...");
    log(`Policy presets to restore: [${builtinPolicyPresets.join(",")}]`);
    for (const presetName of builtinPolicyPresets) {
      try {
        log(`Applying preset: ${presetName}`);
        const applied = policies.applyPreset(sandboxName, presetName);
        if (applied) {
          restoredBuiltinPresets.push(presetName);
        } else {
          failedBuiltinPresets.push(presetName);
          failedPresets.push(presetName);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed to apply preset '${presetName}': ${message}`);
        failedBuiltinPresets.push(presetName);
        failedPresets.push(presetName);
      }
    }
    for (const entry of replayableCustomPolicies) {
      try {
        log(`Applying custom preset: ${entry.name}`);
        const applied = policies.applyPresetContent(sandboxName, entry.name, entry.content, {
          custom: { sourcePath: entry.sourcePath },
        });
        if (applied) {
          restoredCustomPresets.push(entry.name);
          if (
            reconcileManagedDcodeObservability &&
            OBSERVABILITY_POLICY_BINDING.ownsContent(entry.content)
          ) {
            successfulCustomObservabilityContents.push(entry.content);
          }
        } else {
          failedPresets.push(entry.name);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed to apply custom preset '${entry.name}': ${message}`);
        failedPresets.push(entry.name);
      }
    }
    const restoredPresets = uniquePresetNames([
      ...restoredBuiltinPresets,
      ...restoredCustomPresets,
    ]);
    if (restoredPresets.length > 0) {
      console.log(`  ${G}\u2713${R} Policy presets restored: ${restoredPresets.join(", ")}`);
    }
    if (failedPresets.length > 0) {
      console.error(`  ${YW}\u26a0${R} Failed to restore presets: ${failedPresets.join(", ")}`);
      console.error(`    Re-apply manually with: ${CLI_NAME} ${sandboxName} policy-add`);
    }
  }

  const restoredPresets = uniquePresetNames([...restoredBuiltinPresets, ...restoredCustomPresets]);
  const finalPolicyState = reconcileManagedDcodeObservability
    ? reconcileFinalManagedObservability(
        sandboxName,
        targetManagedObservability,
        restoredBuiltinPresets,
        restoredCustomPresets,
        failedBuiltinPresets,
        successfulCustomObservabilityContents,
        log,
      )
    : {
        finalBuiltinPresets: uniquePresetNames(restoredBuiltinPresets),
        finalPresets: restoredPresets,
        failedPresetRemovals: [],
        policyPresetReconciliationVerified: true,
      };
  return { restoreSucceeded, restoredPresets, failedPresets, ...finalPolicyState };
}
