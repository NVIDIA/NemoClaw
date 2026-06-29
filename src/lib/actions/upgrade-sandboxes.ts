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
import { parseReadySandboxNames } from "../runtime-recovery";
import * as sandboxVersion from "../sandbox/version";
import * as registry from "../state/registry";
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

  // Classify sandboxes as stale, unknown, or current. Pass the running NemoClaw
  // build so a NemoClaw image/build change is detected even when the agent
  // version is unchanged (#5026).
  const { stale, unknown } = classifyUpgradeableSandboxes(
    sandboxes,
    liveNames,
    (name) => checkAgentVersionForUpgrade(name, liveNames),
    { currentNemoclawVersion: resolveCurrentNemoclawVersion() },
  );

  if (stale.length === 0 && unknown.length === 0) {
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
  console.log("");

  if (checkOnly) {
    if (stale.length > 0) console.log(`  ${stale.length} sandbox(es) need upgrading.`);
    if (unknown.length > 0) {
      console.log(
        `  ${unknown.length} sandbox(es) could not be version-checked; start them and rerun, or rebuild manually.`,
      );
    }
    console.log(`  Run \`${CLI_NAME} upgrade-sandboxes\` to rebuild them.`);
    return;
  }

  const { rebuildable, stopped } = splitRebuildableSandboxes(stale);
  if (stopped.length > 0) {
    console.log(`  ${D}Skipping ${stopped.length} stopped sandbox(es) — start them first.${R}`);
  }
  if (rebuildable.length === 0) {
    console.log("  No running stale sandboxes to rebuild.");
    return;
  }

  let rebuilt = 0;
  let failed = 0;
  for (const s of rebuildable) {
    if (!skipConfirm) {
      const answer = await askPrompt(`  Rebuild '${s.name}'? [y/N]: `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        console.log(`  Skipped '${s.name}'.`);
        continue;
      }
    }
    try {
      await rebuildSandbox(s.name, ["--yes"], { throwOnError: true });
      rebuilt++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`  ${YW}⚠${R} Failed to rebuild '${s.name}': ${errorMessage}`);
      failed++;
    }
  }

  console.log("");
  if (rebuilt > 0) console.log(`  ${G}✓${R} ${rebuilt} sandbox(es) rebuilt.`);
  if (failed > 0) console.log(`  ${YW}⚠${R} ${failed} sandbox(es) failed — see errors above.`);
  if (failed > 0) process.exit(1);
}
