// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../adapters/openshell/gateway-drift";
import { CLI_NAME } from "../cli/branding";
import { B, D, G, R, YW } from "../cli/terminal-style";
import { getVersion } from "../core/version";
import { prompt as askPrompt } from "../credentials/store";
import {
  normalizeUpgradeSandboxesOptions,
  type UpgradeSandboxesOptions,
} from "../domain/lifecycle/options";
import {
  classifyUpgradeableSandboxes,
  shouldSkipUpgradeConfirmation,
  splitRebuildableSandboxes,
  type UpgradeSandboxCandidate,
} from "../domain/maintenance/upgrade";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../openshell-sandbox-list";
import { parseLiveSandboxEntries, parseReadySandboxNames } from "../runtime-recovery";
import * as sandboxVersion from "../sandbox/version";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";
import { rebuildSandbox } from "./sandbox/rebuild";

// ── Upgrade sandboxes (#1904) ────────────────────────────────────
// Detect sandboxes running stale agent versions and offer to rebuild them.

/**
 * Checks the sandbox agent version with a live probe when the sandbox is running.
 */
function checkAgentVersionForUpgrade(
  sandboxName: string,
  liveNames: Set<string>,
): sandboxVersion.VersionCheckResult {
  return sandboxVersion.checkAgentVersion(
    sandboxName,
    liveNames.has(sandboxName) ? { forceProbe: true } : undefined,
  );
}

/**
 * Resolve the running NemoClaw build fingerprint used for image-drift
 * detection. Returns null when the version cannot be read so classification
 * falls back to agent-version-only (legacy) behavior (#5026).
 */
function resolveCurrentNemoclawVersion(): string | null {
  try {
    return getVersion();
  } catch {
    return null;
  }
}

/**
 * Build a human-readable description of why a sandbox needs rebuilding, covering
 * an outdated agent version, NemoClaw image/build drift, or both (#5026).
 */
function describeStaleUpgrade(s: UpgradeSandboxCandidate): string {
  const reasons = s.reasons ?? [];
  const parts: string[] = [];
  if (reasons.includes("agent-version")) {
    parts.push(`v${s.current || "?"} → v${s.expected}`);
  } else if (reasons.includes("image-drift") && s.current) {
    // Agent version is current; make clear it is the NemoClaw image that drifted.
    parts.push(`v${s.current} unchanged`);
  }
  if (reasons.includes("image-drift")) {
    const from = s.imageCurrent ? `v${s.imageCurrent}` : "unknown build";
    parts.push(`NemoClaw image ${from} → v${s.imageExpected}`);
  }
  return parts.join("; ");
}

type PreparedBackupRecovery = {
  sandbox: registry.SandboxEntry;
  manifest: sandboxState.RebuildManifest;
};

type RejectedBackupRecovery = {
  sandbox: registry.SandboxEntry;
  reason: string;
};

function prepareBackupRecovery(
  sandbox: registry.SandboxEntry,
): PreparedBackupRecovery | RejectedBackupRecovery {
  try {
    const latest = sandboxState.getLatestBackup(sandbox.name);
    if (!latest) {
      return { sandbox, reason: "no validated pre-upgrade backup was found" };
    }

    const validation = sandboxState.validateRebuildRecoveryManifest(
      sandbox.name,
      sandbox.agent,
      latest,
    );
    if (!validation.ok) {
      return { sandbox, reason: validation.reason };
    }
    if (!sandboxState.hasPositiveManagedImageEvidence(sandbox)) {
      return {
        sandbox,
        reason:
          "registry has no NemoClaw-managed image fingerprint (pre-fingerprint and custom images are not auto-recreated)",
      };
    }
    return { sandbox, manifest: validation.manifest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { sandbox, reason: `backup recovery assessment failed: ${detail}` };
  }
}

function isPreparedBackupRecovery(
  candidate: PreparedBackupRecovery | RejectedBackupRecovery,
): candidate is PreparedBackupRecovery {
  return "manifest" in candidate;
}

export async function upgradeSandboxes(
  options: string[] | UpgradeSandboxesOptions = {},
): Promise<void> {
  const normalized = normalizeUpgradeSandboxesOptions(options);
  const checkOnly = normalized.check === true;
  const skipConfirm = shouldSkipUpgradeConfirmation(normalized);

  const sandboxes = registry.listSandboxes().sandboxes;
  if (sandboxes.length === 0) {
    console.log("  No sandboxes found in the registry.");
    return;
  }

  // Query live sandboxes so we can tell the user which are running
  const preflightIssue = detectOpenShellStateRpcPreflightIssue();
  if (preflightIssue) {
    printOpenShellStateRpcIssue(preflightIssue, {
      action: "checking sandbox upgrade state",
      command: `${CLI_NAME} upgrade-sandboxes`,
    });
    process.exit(1);
  }

  const liveRecovery = await captureSandboxListWithGatewayRecovery();
  const liveResult = liveRecovery.result;
  const resultIssue = detectOpenShellStateRpcResultIssue(liveResult);
  if (resultIssue) {
    printOpenShellStateRpcIssue(resultIssue, {
      action: "checking sandbox upgrade state",
      command: `${CLI_NAME} upgrade-sandboxes`,
    });
    process.exit(1);
  }
  if (liveResult.status !== 0) {
    printSandboxListFailureWithRecoveryContext(liveRecovery);
    process.exit(liveResult.status || 1);
  }
  const liveNames = parseReadySandboxNames(liveResult.output || "");
  // Absence from the selected gateway is not evidence of failure: a registered
  // sandbox may be Ready on another recorded gateway. Only an explicitly
  // observed, known non-Ready phase is eligible for prepared-backup recovery.
  const nonReadyLiveNames = new Set(
    parseLiveSandboxEntries(liveResult.output || "")
      .filter(
        (entry) => entry.phase !== null && entry.phase !== "Ready" && entry.phase !== "Running",
      )
      .map((entry) => entry.name),
  );

  // Classify sandboxes as stale, unknown, or current. Pass the running NemoClaw
  // build so a NemoClaw image/build change is detected even when the agent
  // version is unchanged (#5026).
  const { stale, unknown } = classifyUpgradeableSandboxes(
    sandboxes,
    liveNames,
    (name) => checkAgentVersionForUpgrade(name, liveNames),
    { currentNemoclawVersion: resolveCurrentNemoclawVersion() },
  );

  // Source boundary (#6114): a v0.0.55/legacy-OpenShell install can leave its
  // already-registered sandboxes in Provisioning/Error after the host upgrade.
  // That state comes from the already-installed legacy CLI/gateway and cannot be
  // prevented at its source by this candidate. install.sh exports this signal only
  // after that CLI completes backup-all, or after an operator asserts prepared
  // upgrade state. Recovery remains limited to registry entries with a managed-image
  // fingerprint; pre-fingerprint entries cannot prove provenance and fail closed.
  // upgrade-sandboxes-recovery.test.ts and
  // install-preexisting-sandbox-recovery.test.ts guard the handoff. Remove this
  // bridge with onboard's matching consumer once prepared-backup installer recovery
  // is no longer supported.
  const recoverPreparedBackups = process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
  const backupRecoveryAssessments = recoverPreparedBackups
    ? sandboxes.filter((sandbox) => nonReadyLiveNames.has(sandbox.name)).map(prepareBackupRecovery)
    : [];
  const preparedRecoveries = backupRecoveryAssessments.filter(isPreparedBackupRecovery);
  const rejectedRecoveries = backupRecoveryAssessments.filter(
    (candidate): candidate is RejectedBackupRecovery => !isPreparedBackupRecovery(candidate),
  );
  const assessedRecoveryNames = new Set(
    backupRecoveryAssessments.map((candidate) => candidate.sandbox.name),
  );

  if (
    stale.length === 0 &&
    unknown.length === 0 &&
    preparedRecoveries.length === 0 &&
    rejectedRecoveries.length === 0
  ) {
    console.log("  All sandboxes are up to date.");
    return;
  }

  if (stale.length > 0) {
    console.log(`\n  ${B}Stale sandboxes:${R}`);
    for (const s of stale) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  ${describeStaleUpgrade(s)}  (${status})`);
    }
  }
  if (unknown.length > 0) {
    console.log(`\n  ${YW}Unknown version:${R}`);
    for (const s of unknown) {
      const status = s.running ? `${G}running${R}` : `${D}stopped${R}`;
      console.log(`    ${s.name}  v? → v${s.expected}  (${status})`);
    }
  }
  if (preparedRecoveries.length > 0) {
    console.log(`\n  ${B}Prepared backup recovery:${R}`);
    for (const recovery of preparedRecoveries) {
      console.log(
        `    ${recovery.sandbox.name}  ${D}${recovery.manifest.timestamp}${R}  (non-Ready)`,
      );
    }
  }
  if (rejectedRecoveries.length > 0) {
    console.log(`\n  ${YW}Backup recovery blocked:${R}`);
    for (const recovery of rejectedRecoveries) {
      console.error(`    ${recovery.sandbox.name}  ${recovery.reason}`);
    }
  }
  console.log("");

  if (checkOnly) {
    if (stale.length > 0) console.log(`  ${stale.length} sandbox(es) need upgrading.`);
    if (unknown.length > 0) {
      console.log(
        `  ${unknown.length} sandbox(es) could not be version-checked; start them and rerun, or rebuild manually.`,
      );
    }
    if (preparedRecoveries.length > 0) {
      console.log(
        `  ${preparedRecoveries.length} non-Ready sandbox(es) have a validated pre-upgrade backup.`,
      );
    }
    if (rejectedRecoveries.length > 0) {
      console.log(
        `  ${rejectedRecoveries.length} non-Ready sandbox(es) cannot be recovered automatically.`,
      );
    }
    console.log(`  Run \`${CLI_NAME} upgrade-sandboxes\` to rebuild them.`);
    return;
  }

  const { rebuildable, stopped } = splitRebuildableSandboxes(stale);
  const notObservedReadyOrNonReady = stopped.filter(
    (sandbox) => !assessedRecoveryNames.has(sandbox.name),
  );
  if (notObservedReadyOrNonReady.length > 0) {
    console.log(
      `  ${D}Skipping ${notObservedReadyOrNonReady.length} sandbox(es) not observed on the selected gateway — verify their recorded gateway or start them first.${R}`,
    );
  }
  if (
    rebuildable.length === 0 &&
    preparedRecoveries.length === 0 &&
    rejectedRecoveries.length === 0
  ) {
    console.log("  No running stale sandboxes to rebuild.");
    return;
  }

  let rebuilt = 0;
  let failed = rejectedRecoveries.length;
  const work = [
    ...rebuildable.map((sandbox) => ({ sandbox, manifest: null })),
    ...preparedRecoveries.map((recovery) => ({
      sandbox: { name: recovery.sandbox.name },
      manifest: recovery.manifest,
    })),
  ];
  for (const item of work) {
    const { sandbox, manifest } = item;
    if (!skipConfirm) {
      const verb = manifest ? "Recover" : "Rebuild";
      const answer = await askPrompt(`  ${verb} '${sandbox.name}'? [y/N]: `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        console.log(`  Skipped '${sandbox.name}'.`);
        continue;
      }
    }
    try {
      await rebuildSandbox(sandbox.name, ["--yes"], {
        throwOnError: true,
        recoveryManifest: manifest ?? undefined,
      });
      rebuilt++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const verb = manifest ? "recover" : "rebuild";
      console.error(`  ${YW}⚠${R} Failed to ${verb} '${sandbox.name}': ${errorMessage}`);
      failed++;
    }
  }

  console.log("");
  if (rebuilt > 0) console.log(`  ${G}✓${R} ${rebuilt} sandbox(es) rebuilt.`);
  if (failed > 0) console.log(`  ${YW}⚠${R} ${failed} sandbox(es) failed — see errors above.`);
  if (failed > 0) process.exit(1);
}
