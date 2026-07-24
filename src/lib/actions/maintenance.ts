// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerListImagesFormat, dockerRmi } from "../adapters/docker";
import { CLI_NAME } from "../cli/branding";
import { GATEWAY_PORT } from "../core/ports";
import { prompt as askPrompt } from "../credentials/store";
import { formatFailedBackupItems } from "../domain/backup-failure";
import {
  type GarbageCollectImagesOptions,
  normalizeGarbageCollectImagesOptions,
} from "../domain/lifecycle/options";
import { findOrphanedSandboxImages, parseSandboxImageRows } from "../domain/maintenance/images";
import {
  classifyOrphanedRegistrySandboxes,
  orphanedRegistryRemediation,
  orphanedRegistrySummary,
} from "../domain/maintenance/orphan-detection";
import { SANDBOX_IMAGE_REPOS } from "../domain/sandbox/image-tag";
import { resolveGatewayName, resolveSandboxGatewayName } from "../onboard/gateway-binding";
import { captureSandboxListWithGatewayPreflightOrExit } from "../openshell-sandbox-list";
import { parseLiveSandboxNames, parseReadySandboxNames } from "../runtime-recovery";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";
import { nemoclawStateRoot, resolveHome } from "../state/state-root";
import {
  backupStartedSandboxState,
  isSandboxContainerDefinitivelyAbsent,
  returnSandboxContainerToStopped,
  type StartedForBackup,
  startStoppedSandboxContainerForBackup,
} from "./sandbox/stopped-sandbox-backup";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";
const YW = useColor ? "\x1b[1;33m" : "";

export function shouldSkipUnreachableSandboxBackup(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP === "1";
}

export function rebuildBackupsDirectory(home: string, gatewayPort: number): string {
  return path.join(nemoclawStateRoot(home, gatewayPort), "rebuild-backups");
}

function notRunningBackupSkipMessage(name: string): string {
  return `Skipping '${name}' (not running; start the sandbox/container and rerun '${CLI_NAME} backup-all' so NemoClaw can capture a fresh snapshot)`;
}

export async function backupAll(): Promise<void> {
  const sandboxes = registry
    .listSandboxes()
    .sandboxes.filter((sandbox) => !registry.isRouteOnlySandboxReservation(sandbox));
  if (sandboxes.length === 0) {
    console.log("  No sandboxes registered. Nothing to back up.");
    return;
  }

  // Pin the listing to the selected gateway (#6114/#6520): OpenShell's
  // mutable current selection may be a sibling gateway, and an unpinned list
  // would both misjudge readiness and let the orphan classifier below make a
  // fail-open stranded call from another gateway's sandboxes.
  const selectedGatewayName = resolveGatewayName(GATEWAY_PORT);
  const liveList = await captureSandboxListWithGatewayPreflightOrExit(
    {
      action: "backing up registered sandboxes",
      command: `${CLI_NAME} backup-all`,
    },
    { gatewayName: selectedGatewayName },
  );
  const readyNames = parseReadySandboxNames(liveList.output || "");
  // Source-of-truth review (#6520):
  //
  // - Invalid state: a sandbox the selected gateway does not observe, whose
  //   persisted binding resolves to that gateway, and whose OpenShell-labeled
  //   container is definitively absent is stranded. It has no state left to
  //   back up, so counting it as a strict-gate skip would abort the
  //   installer's pre-upgrade backup before its recovery phase
  //   (recover_preexisting_sandboxes_before_onboard in scripts/install.sh)
  //   that knows how to surface it ever runs.
  // - Source boundary: the state is created by `nemoclaw uninstall`, which
  //   removes the gateway registration and containers but deliberately
  //   preserves sandboxes.json so a later reinstall can rebuild from it.
  // - Source-fix constraint: backup-all must not reconcile the registry —
  //   clearing a stranded record is owned by the recovery phase's
  //   destroy/onboard guidance (and the user), and this gate runs before
  //   that phase. Deleting records inside a backup command would destroy the
  //   very evidence the recovery phase reports.
  // - Removal condition: drop this exemption when install/uninstall
  //   reconciles sandboxes.json against the gateway (stranded records can no
  //   longer reach backup-all), or when the installer runs its recovery
  //   phase before the strict pre-upgrade backup.
  //
  // The container-absence gate (checked per candidate at skip time and again
  // after the confirming listing) makes the exemption race-safe: a
  // reconnecting or sibling-healthy sandbox still has a container, and a
  // candidate the gateway observes again reverts to a genuine strict skip.
  const orphanNames = new Set(
    classifyOrphanedRegistrySandboxes(sandboxes, {
      observedNames: parseLiveSandboxNames(liveList.output || ""),
      reconnectedNames: new Set(),
      selectedGatewayName,
      resolveGatewayBinding: resolveSandboxGatewayName,
    }).map((sandbox) => sandbox.name),
  );

  const skipUnreachable = shouldSkipUnreachableSandboxBackup(process.env);
  const requireAll = process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS === "1";
  let backed = 0;
  let failed = 0;
  let skipped = 0;
  let unreachableRunning = 0;
  let notRunningSkipped = 0;
  const strandedOrphans: string[] = [];
  for (const sb of sandboxes) {
    // A registered docker-driver sandbox whose container is merely stopped is
    // backupable: start it for the duration of the backup and return it to
    // its stopped state after (#6500). Anything else that is not Ready keeps
    // the existing skip (and, under installer-strict mode, the #6114 gate).
    let startedForBackup: StartedForBackup | null = null;
    if (!readyNames.has(sb.name)) {
      startedForBackup = startStoppedSandboxContainerForBackup(sb.name);
      if (!startedForBackup) {
        if (orphanNames.has(sb.name) && isSandboxContainerDefinitivelyAbsent(sb.name)) {
          // Tracked separately from `skipped` so the strict gate stays
          // untripped: there is nothing to back up and nothing to start.
          strandedOrphans.push(sb.name);
          continue;
        }
        console.log(`  ${D}${notRunningBackupSkipMessage(sb.name)}${R}`);
        skipped++;
        notRunningSkipped++;
        continue;
      }
      console.log(`  Starting stopped sandbox '${sb.name}' to back it up...`);
    }
    console.log(`  Backing up '${sb.name}'...`);
    let result: sandboxState.BackupResult | null = null;
    let orphanManifestMessage: string | null = null;
    let returnedToStopped = true;
    try {
      result = startedForBackup
        ? await backupStartedSandboxState(sb.name)
        : sandboxState.backupSandboxState(sb.name);
    } catch (err: unknown) {
      // Source-of-truth review (#5734 / #5819):
      //
      // - Invalid state: a sandbox in the registry references an agent whose
      //   manifest no longer exists on disk (orphan after a higher-version
      //   install replaced the manifest tree). loadAgent() at
      //   src/lib/agent/defs.ts:365-372 throws `Agent '<name>' not found:
      //   <manifestPath>` when this happens.
      // - Source boundary: the orphan is owned upstream by the install/upgrade
      //   flow that mutates the agents/ directory without reconciling the
      //   registry. The narrow skip here exists purely so the pre-upgrade
      //   backup-all loop survives until the upgrade itself reinstalls the
      //   missing manifest.
      // - Source-fix constraint: the registry cannot be reconciled before the
      //   backup runs because the backup IS what gates the upgrade that ships
      //   the reconciled manifests. A registry-side fix at boot or post-install
      //   would solve the root cause but is out of scope here.
      // - Regression test: maintenance.test.ts covers the orphan-skip,
      //   skipped-not-failed counter, non-orphan re-throw (EACCES), and the
      //   `: <path>`-suffixed shape boundary so widening or eliminating the
      //   matcher fails CI.
      // - Removal condition: drop this catch when the registry is reconciled
      //   on install/upgrade and orphan sandboxes can no longer reach
      //   backup-all (or when backupSandboxState surfaces a typed
      //   MissingAgentManifestError that the caller can identify without
      //   string matching).
      //
      // Anchored to the exact loadAgent() throw shape. Requiring the
      // `: <path>` suffix prevents accidentally catching unrelated
      // "Agent '...' not found" messages from other layers that should still
      // abort the backup batch (disk full, SSH timeout, permission denied,
      // programming bugs all propagate).
      const msg = err instanceof Error ? err.message : String(err);
      if (!/^Agent '[^']+' not found: .+\/manifest\.yaml$/.test(msg)) {
        throw err;
      }
      orphanManifestMessage = msg;
    } finally {
      if (startedForBackup) {
        if (returnSandboxContainerToStopped(startedForBackup.containerName)) {
          console.log(`  ${D}Returned '${sb.name}' to its stopped state.${R}`);
        } else {
          returnedToStopped = false;
          console.error(
            `  ${RD}✗${R} ${sb.name}: backup cleanup failed (could not return its container to the stopped state; the container was left running)`,
          );
        }
      }
    }
    if (!returnedToStopped) {
      failed++;
      continue;
    }
    if (orphanManifestMessage) {
      console.log(`  ${YW}⚠${R} Skipped '${sb.name}' (orphan manifest): ${orphanManifestMessage}`);
      skipped++;
      continue;
    }
    if (!result) throw new Error(`Backup for '${sb.name}' completed without a result`);
    if (result.success) {
      console.log(
        `  ${G}✓${R} ${sb.name}: ${result.backedUpDirs.length} dirs, ${result.backedUpFiles.length} files → ${result.manifest?.backupPath || "unknown"}`,
      );
      backed++;
    } else {
      if (result.unreachable) {
        if (skipUnreachable) {
          console.log(
            `  ${YW}⚠${R} Skipped '${sb.name}' (running but SSH-unreachable; NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1 set). Any uncommitted state since the last successful backup will be lost.`,
          );
          skipped++;
          continue;
        }
        unreachableRunning++;
      }
      const failedItems = formatFailedBackupItems(
        [...result.failedDirs, ...result.failedFiles],
        result.failedDirReasons,
      );
      console.error(`  ${RD}✗${R} ${sb.name}: backup failed (${failedItems})`);
      failed++;
    }
  }
  // The classification above is only as fresh as the pre-loop listing, and
  // the backup loop can run for minutes. Confirm with a second pinned listing
  // that every stranded candidate is still unobserved before accepting the
  // exemption (same two-phase confirmation as upgrade-sandboxes, #6114); a
  // candidate that reappeared reverts to the genuine strict skip it would
  // otherwise have been.
  let confirmedStranded = strandedOrphans;
  if (strandedOrphans.length > 0) {
    const confirmation = await captureSandboxListWithGatewayPreflightOrExit(
      {
        action: "confirming stranded sandboxes remain absent from the selected gateway",
        command: `${CLI_NAME} backup-all`,
      },
      { gatewayName: selectedGatewayName },
    );
    const observedOnRecheck = parseLiveSandboxNames(confirmation.output || "");
    confirmedStranded = strandedOrphans.filter(
      (name) => !observedOnRecheck.has(name) && isSandboxContainerDefinitivelyAbsent(name),
    );
    const confirmedNames = new Set(confirmedStranded);
    for (const name of strandedOrphans.filter((entry) => !confirmedNames.has(entry))) {
      console.log(`  ${D}${notRunningBackupSkipMessage(name)}${R}`);
      skipped++;
      notRunningSkipped++;
    }
  }
  console.log("");
  console.log(`  Pre-upgrade backup: ${backed} backed up, ${failed} failed, ${skipped} skipped`);
  if (backed > 0) {
    console.log(`  Backups stored in: ${rebuildBackupsDirectory(resolveHome(), GATEWAY_PORT)}`);
  }
  if (confirmedStranded.length > 0) {
    console.log(`  ${YW}${orphanedRegistrySummary(confirmedStranded)}${R}`);
    console.log(`  ${D}${orphanedRegistryRemediation(CLI_NAME)}${R}`);
  }
  if (failed > 0) {
    if (unreachableRunning > 0) {
      console.error("");
      console.error(
        `  ${unreachableRunning} running sandbox(es) could not be backed up because their in-sandbox SSH endpoint did not answer.`,
      );
      if (requireAll) {
        console.error(
          `  Strict pre-upgrade backup cannot skip these sandboxes. Restore their gateway health, then run '${CLI_NAME} backup-all' again.`,
        );
      } else {
        console.error(
          `  To upgrade now and recover them afterwards from their latest validated backup, re-run with NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1. Any uncommitted state since the last successful backup will be lost.`,
        );
        console.error(
          `  To preserve their current state first, stop the affected container (so it is skipped as not running) or restore its gateway health, then run '${CLI_NAME} backup-all' again.`,
        );
      }
    }
  }
  if (requireAll && skipped > 0) {
    console.error("");
    console.error(
      `  Strict pre-upgrade backup requires every registered sandbox to be backed up; ${skipped} sandbox(es) were skipped.`,
    );
    if (notRunningSkipped > 0) {
      console.error(
        `  ${notRunningSkipped} skipped sandbox(es) were not running. Start each sandbox/container, then rerun the installer or '${CLI_NAME} backup-all'.`,
      );
    }
    console.error("  Resolve each skipped sandbox using its reason above and retry.");
  }
  if (failed > 0 || (requireAll && skipped > 0)) process.exit(1);
}

export async function garbageCollectImages(
  options: string[] | GarbageCollectImagesOptions = {},
): Promise<void> {
  const normalized = normalizeGarbageCollectImagesOptions(options);
  const dryRun = normalized.dryRun === true;
  const skipConfirm = normalized.yes === true || normalized.force === true;

  let imagesOutput = "";
  try {
    // Scan every sandbox image repo, not just sandbox-from; see
    // SANDBOX_IMAGE_REPOS for why local prebuilds were missed (#6301).
    imagesOutput = SANDBOX_IMAGE_REPOS.map((repo) =>
      dockerListImagesFormat(repo, "{{.Repository}}:{{.Tag}}\t{{.Size}}"),
    ).join("\n");
  } catch {
    console.error("  Failed to query Docker images. Is Docker running?");
    process.exit(1);
  }

  const allImages = parseSandboxImageRows(imagesOutput);

  if (allImages.length === 0) {
    console.log("  No sandbox images found on the host.");
    return;
  }

  const { sandboxes } = registry.listSandboxes();
  const orphans = findOrphanedSandboxImages(allImages, sandboxes);

  if (orphans.length === 0) {
    console.log(`  All ${allImages.length} sandbox image(s) are in use. Nothing to clean up.`);
    return;
  }

  console.log(`  Found ${orphans.length} orphaned sandbox image(s):\n`);
  for (const img of orphans) {
    console.log(`    ${img.tag}  ${D}(${img.size})${R}`);
  }
  console.log("");

  if (dryRun) {
    console.log(`  --dry-run: would remove ${orphans.length} image(s).`);
    return;
  }

  if (!skipConfirm) {
    const answer = await askPrompt(`  Remove ${orphans.length} orphaned image(s)? [y/N]: `);
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  let removed = 0;
  let failed = 0;
  for (const img of orphans) {
    const rmiResult = dockerRmi(img.tag, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      ignoreError: true,
      suppressOutput: true,
    });
    if (rmiResult.status === 0) {
      console.log(`  ${G}✓${R} Removed ${img.tag}`);
      removed++;
    } else {
      const details = `${rmiResult.stderr || rmiResult.stdout || ""}`.trim();
      console.error(`  ${YW}⚠${R} Failed to remove ${img.tag}${details ? `: ${details}` : ""}`);
      failed++;
    }
  }

  console.log("");
  if (removed > 0) console.log(`  ${G}✓${R} Removed ${removed} orphaned image(s).`);
  if (failed > 0) console.log(`  ${YW}⚠${R} Failed to remove ${failed} image(s).`);
  if (failed > 0) process.exit(1);
}
