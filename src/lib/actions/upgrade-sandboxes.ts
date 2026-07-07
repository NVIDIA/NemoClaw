// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { B, D, G, R, YW } from "../cli/terminal-style";
import { GATEWAY_PORT } from "../core/ports";
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
import { resolveGatewayName, resolveSandboxGatewayName } from "../onboard/gateway-binding";
import { captureSandboxListWithGatewayPreflightOrExit } from "../openshell-sandbox-list";
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
  allowLegacyManagedImageRecovery: boolean;
};

type RejectedBackupRecovery = {
  sandbox: registry.SandboxEntry;
  reason: string;
};

function prepareBackupRecovery(
  sandbox: registry.SandboxEntry,
  allowLegacyManagedImageRecovery: boolean,
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
    const hasManagedImageEvidence = sandboxState.hasPositiveManagedImageEvidence(sandbox);
    if (!sandboxState.isManagedImageRecoveryAllowed(sandbox, allowLegacyManagedImageRecovery)) {
      return {
        sandbox,
        reason:
          "registry has no NemoClaw-managed image fingerprint (pre-fingerprint images require explicit managed-image confirmation; custom images are not auto-recreated)",
      };
    }
    return {
      sandbox,
      manifest: validation.manifest,
      allowLegacyManagedImageRecovery: !hasManagedImageEvidence,
    };
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

function confirmedLegacyManagedRecoveryNames(): Set<string> {
  const raw = process.env.NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES;
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string")) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

// Under installer restore intent, a registry sandbox the selected gateway does
// not report Ready/Running is eligible for prepared-backup recovery only when
// its persisted binding resolves to that selected gateway, whether the gateway
// observes it in a non-Ready phase or it is absent. Observation alone is
// insufficient: a sandbox bound to a different recorded gateway may be Ready
// there, so recovering it would clobber a healthy sandbox.
// resolveSandboxGatewayName throws on an invalid persisted
// binding — report that fixed, sanitized condition and treat it as ineligible so
// a corrupted registry row never drives a recreate. Remove this guard only when
// every registry write path validates gateway bindings before persistence.
function isPreparedRecoveryCandidate(
  sandbox: registry.SandboxEntry,
  liveNames: Set<string>,
  selectedGatewayName: string,
): boolean {
  if (liveNames.has(sandbox.name)) return false;
  try {
    return resolveSandboxGatewayName(sandbox) === selectedGatewayName;
  } catch {
    console.warn(
      `  Warning: sandbox ${JSON.stringify(sandbox.name)} has an invalid persisted gateway binding; skipping prepared-backup recovery.`,
    );
    return false;
  }
}

// A sandbox the gateway already observes in a non-Ready phase does not need
// further confirmation — its state is already known from the one listing. A
// sandbox that is merely absent might instead still be reconnecting to a
// just-recreated gateway, so absence is confirmed against a second, independent
// listing before it can drive a recreate: a sandbox that has become Ready by
// the second read is dropped rather than rebuilt from a possibly stale backup.
// A non-Ready phase on the second read remains eligible because prepared-backup
// restore intent explicitly targets sandboxes stuck in those phases.
// Any confirmation preflight or listing failure deliberately aborts the whole
// command, even when other candidates were already observed. Continuing after
// target-gateway evidence becomes unavailable could mix stale and current state
// in one destructive recovery run, so uncorroborated absence always fails closed.
async function confirmAbsentRecoveryCandidates(
  absentCandidates: registry.SandboxEntry[],
  selectedGatewayName: string,
): Promise<registry.SandboxEntry[]> {
  if (absentCandidates.length === 0) return absentCandidates;
  const confirmation = await captureSandboxListWithGatewayPreflightOrExit(
    {
      action: "confirming sandboxes absent from the selected gateway",
      command: `${CLI_NAME} upgrade-sandboxes`,
    },
    { gatewayName: selectedGatewayName },
  );
  const confirmedLiveNames = parseReadySandboxNames(confirmation.output || "");
  return absentCandidates.filter((sandbox) => !confirmedLiveNames.has(sandbox.name));
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

  // Resolve the configured gateway once and pin every observation to it. The
  // initial list, the confirmation list, and persisted-binding eligibility must
  // share this source; OpenShell's mutable current selection may be a sibling
  // gateway where the same sandbox name has different state.
  const selectedGatewayName = resolveGatewayName(GATEWAY_PORT);
  const liveResult = await captureSandboxListWithGatewayPreflightOrExit(
    {
      action: "checking sandbox upgrade state",
      command: `${CLI_NAME} upgrade-sandboxes`,
    },
    { gatewayName: selectedGatewayName },
  );
  const liveNames = parseReadySandboxNames(liveResult.output || "");
  // Sandboxes the selected gateway observes in a non-Ready phase. Absence from
  // the selected gateway is handled by isPreparedRecoveryCandidate, which recovers
  // an absent sandbox only when it resolves to the selected gateway.
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
  // after the current CLI completes a strict backup, or after an operator asserts
  // prepared upgrade state. Pre-fingerprint OpenClaw/Hermes rows require a separate,
  // exact-name confirmation that they used a managed image; custom-image evidence
  // still fails closed.
  // upgrade-sandboxes-recovery.test.ts and
  // install-preexisting-sandbox-recovery.test.ts guard the handoff. Remove this
  // bridge with onboard's matching consumer once prepared-backup installer recovery
  // is no longer supported.
  const recoverPreparedBackups = process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
  const confirmedLegacyManagedNames = recoverPreparedBackups
    ? confirmedLegacyManagedRecoveryNames()
    : new Set<string>();
  const registeredSandboxNames = new Set(sandboxes.map((sandbox) => sandbox.name));
  for (const name of confirmedLegacyManagedNames) {
    if (registeredSandboxNames.has(name)) continue;
    console.warn(
      `  Warning: confirmed legacy managed-image sandbox ${JSON.stringify(name)} is not registered; ignoring it.`,
    );
    confirmedLegacyManagedNames.delete(name);
  }
  let recoveryCandidates: registry.SandboxEntry[] = [];
  if (recoverPreparedBackups) {
    const gatewayEligible = sandboxes.filter((sandbox) =>
      isPreparedRecoveryCandidate(sandbox, liveNames, selectedGatewayName),
    );
    const nonReadyCandidates = gatewayEligible.filter((sandbox) =>
      nonReadyLiveNames.has(sandbox.name),
    );
    const absentCandidates = gatewayEligible.filter(
      (sandbox) => !nonReadyLiveNames.has(sandbox.name),
    );
    const confirmedAbsentCandidates = await confirmAbsentRecoveryCandidates(
      absentCandidates,
      selectedGatewayName,
    );
    recoveryCandidates = [...nonReadyCandidates, ...confirmedAbsentCandidates];
  }
  const backupRecoveryAssessments = recoveryCandidates.map((sandbox) =>
    prepareBackupRecovery(
      sandbox,
      confirmedLegacyManagedNames.has(sandbox.name) &&
        (sandbox.agent == null || sandbox.agent === "openclaw" || sandbox.agent === "hermes"),
    ),
  );
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
      ...(recovery.allowLegacyManagedImageRecovery
        ? { allowLegacyManagedImageRecovery: true as const }
        : {}),
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
        ...("allowLegacyManagedImageRecovery" in item
          ? { allowLegacyManagedImageRecovery: true }
          : {}),
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
