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
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";
import { nemoclawStateRoot, resolveHome } from "../state/state-root";
import {
  assertNoHermesPortableHostAuthority,
  defaultPortableStateDir,
  withPortableHostFence,
} from "../state/portable-uninstall-retirement";
import {
  type BackupShieldsWindowOptions,
  openBackupShieldsWindow,
  relockBackupShieldsWindow,
} from "./sandbox/backup-shields-window";
import * as snapshotBackup from "./sandbox/snapshot/backup-authority";
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

export interface BackupAllOptions {
  purpose?: "pre-uninstall" | "pre-upgrade";
  requireAll?: boolean;
  sandboxNames?: readonly string[];
  skipUnreachable?: boolean;
}

async function withHermesPortableMaintenanceAdmission<T>(
  commandId: "backup-all" | "gc",
  operation: () => Promise<T>,
): Promise<T> {
  const home = resolveHome();
  return withPortableHostFence(home, async () => {
    assertNoHermesPortableHostAuthority(defaultPortableStateDir(process.env), commandId);
    return operation();
  });
}

function notRunningBackupSkipMessage(name: string): string {
  return `Skipping '${name}' (not running; start the sandbox/container and rerun '${CLI_NAME} backup-all' so NemoClaw can capture a fresh snapshot)`;
}

function backupAllShieldsWindowOptions(sandboxName: string): BackupShieldsWindowOptions {
  return {
    operation: "backup-all",
    reason: "auto-unlock for backup-all",
    retryCommand: `${CLI_NAME} backup-all`,
    shieldsUpCommand: `${CLI_NAME} ${sandboxName} shields up`,
  };
}

interface BackupAllSandboxAttempt {
  result: sandboxState.BackupResult | null;
  orphanManifestMessage: string | null;
  shieldsWindowOpened: boolean;
  stoppedContainerUnavailable: boolean;
  mutationLockError?: unknown;
}

function returnStartedSandboxToStopped(
  sandboxName: string,
  startedForBackup: StartedForBackup,
): Error | null {
  const failureDetail =
    "could not return its container to the stopped state; the container was left running";
  const failureMessage = `Backup cleanup failed for '${sandboxName}': ${failureDetail}.`;
  try {
    if (returnSandboxContainerToStopped(startedForBackup.containerName)) {
      console.log(`  ${D}Returned '${sandboxName}' to its stopped state.${R}`);
      return null;
    }
    const error = new Error(failureMessage);
    console.error(`  ${RD}✗${R} ${sandboxName}: backup cleanup failed (${failureDetail})`);
    return error;
  } catch (error) {
    const cleanupError = new Error(failureMessage, { cause: error });
    console.error(`  ${RD}✗${R} ${sandboxName}: backup cleanup failed (${failureDetail})`);
    return cleanupError;
  }
}

function shieldsRelockError(sandboxName: string, cause?: unknown): Error {
  const message = `Shields lockdown could not be restored for '${sandboxName}' after backup-all; aborting remaining backups.`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

async function backupSandboxWithinShieldsWindow(
  sandboxName: string,
  shouldStartStoppedContainer: boolean,
  backup: (
    startedForBackup: StartedForBackup | null,
  ) => sandboxState.BackupResult | Promise<sandboxState.BackupResult>,
): Promise<BackupAllSandboxAttempt> {
  const shieldsWindowOptions = backupAllShieldsWindowOptions(sandboxName);
  let enteredTransactionLock = false;
  try {
    return await withSandboxMutationLock(sandboxName, async () => {
      enteredTransactionLock = true;
      const startedForBackup = shouldStartStoppedContainer
        ? startStoppedSandboxContainerForBackup(sandboxName)
        : null;
      if (shouldStartStoppedContainer && !startedForBackup) {
        return {
          result: null,
          orphanManifestMessage: null,
          shieldsWindowOpened: false,
          stoppedContainerUnavailable: true,
        };
      }
      if (startedForBackup) {
        console.log(`  Starting stopped sandbox '${sandboxName}' to back it up...`);
      }
      let window;
      try {
        window = openBackupShieldsWindow(sandboxName, shieldsWindowOptions);
      } catch (error) {
        if (!startedForBackup) throw error;
        const cleanupError = returnStartedSandboxToStopped(sandboxName, startedForBackup);
        if (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Backup setup for '${sandboxName}' failed and its started container could not be returned to the stopped state.`,
          );
        }
        throw error;
      }
      if (!window) {
        const cleanupError = startedForBackup
          ? returnStartedSandboxToStopped(sandboxName, startedForBackup)
          : null;
        if (cleanupError) throw cleanupError;
        return {
          result: null,
          orphanManifestMessage: null,
          shieldsWindowOpened: false,
          stoppedContainerUnavailable: false,
        };
      }

      console.log(`  Backing up '${sandboxName}'...`);
      let result: sandboxState.BackupResult | null = null;
      let orphanManifestMessage: string | null = null;
      let backupError: unknown;
      let hasBackupError = false;
      let relockError: Error | null = null;
      let stoppedContainerCleanupError: Error | null = null;
      try {
        result = await backup(startedForBackup);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Preserve the narrow pre-upgrade orphan exception, but classify it inside
        // this window so a previously locked sandbox is always relocked before the
        // caller counts the attempt as skipped.
        if (/^Agent '[^']+' not found: .+\/manifest\.yaml$/.test(message)) {
          orphanManifestMessage = message;
        } else {
          backupError = err;
          hasBackupError = true;
        }
      } finally {
        // One lifecycle transaction excludes concurrent NemoClaw destroy and
        // recreate operations through the shields-down window, backup, and
        // cleanup. If auto-restore expires, its deadline gate blocks new
        // lifecycle mutations and waits for this owner. The relock path binds
        // to the active timer token before the lifecycle lock is released.
        try {
          if (!relockBackupShieldsWindow(sandboxName, window, true, shieldsWindowOptions)) {
            relockError = shieldsRelockError(sandboxName);
          }
        } catch (error) {
          relockError = shieldsRelockError(sandboxName, error);
        } finally {
          if (startedForBackup) {
            stoppedContainerCleanupError = returnStartedSandboxToStopped(
              sandboxName,
              startedForBackup,
            );
          }
        }
      }

      if (relockError) {
        if (hasBackupError) {
          throw new AggregateError(
            [
              backupError,
              relockError,
              ...(stoppedContainerCleanupError ? [stoppedContainerCleanupError] : []),
            ],
            `Backup for '${sandboxName}' failed and Shields lockdown could not be restored; aborting remaining backups.`,
          );
        }
        if (orphanManifestMessage) {
          throw new AggregateError(
            [
              new Error(orphanManifestMessage),
              relockError,
              ...(stoppedContainerCleanupError ? [stoppedContainerCleanupError] : []),
            ],
            `Backup for '${sandboxName}' encountered an orphan manifest and Shields lockdown could not be restored; aborting remaining backups.`,
          );
        }
        if (stoppedContainerCleanupError) {
          throw new AggregateError(
            [relockError, stoppedContainerCleanupError],
            `Shields lockdown could not be restored for '${sandboxName}' and its started container could not be returned to the stopped state; aborting remaining backups.`,
          );
        }
        throw relockError;
      }
      if (stoppedContainerCleanupError && hasBackupError) {
        throw new AggregateError(
          [backupError, stoppedContainerCleanupError],
          `Backup for '${sandboxName}' failed and its started container could not be returned to the stopped state; aborting remaining backups.`,
        );
      }
      if (stoppedContainerCleanupError && orphanManifestMessage) {
        throw new AggregateError(
          [new Error(orphanManifestMessage), stoppedContainerCleanupError],
          `Backup for '${sandboxName}' encountered an orphan manifest and its started container could not be returned to the stopped state; aborting remaining backups.`,
        );
      }
      if (stoppedContainerCleanupError) throw stoppedContainerCleanupError;
      if (hasBackupError) throw backupError;
      return {
        result,
        orphanManifestMessage,
        shieldsWindowOpened: true,
        stoppedContainerUnavailable: false,
      };
    });
  } catch (error) {
    if (enteredTransactionLock) throw error;
    return {
      result: null,
      orphanManifestMessage: null,
      shieldsWindowOpened: false,
      stoppedContainerUnavailable: false,
      mutationLockError: error,
    };
  }
}

export async function backupAll(): Promise<void> {
  return withHermesPortableMaintenanceAdmission("backup-all", backupAllUnderPortableHostFence);
}

export async function backupAllUnderPortableHostFence(
  options: BackupAllOptions = {},
): Promise<void> {
  const selectedNames = options.sandboxNames ? new Set(options.sandboxNames) : null;
  const sandboxes = registry
    .listSandboxes()
    .sandboxes.filter(
      (sandbox) =>
        registry.isPublishedSandboxRegistration(sandbox) &&
        (selectedNames === null || selectedNames.has(sandbox.name)),
    );
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
  const readyNames = new Set(
    liveList.sandboxes
      .filter((sandbox) => sandbox.readiness === "ready")
      .map((sandbox) => sandbox.name),
  );
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
      observedNames: new Set(liveList.sandboxes.map((sandbox) => sandbox.name)),
      reconnectedNames: new Set(),
      selectedGatewayName,
      resolveGatewayBinding: resolveSandboxGatewayName,
    }).map((sandbox) => sandbox.name),
  );

  const purpose = options.purpose ?? "pre-upgrade";
  const skipUnreachable =
    options.skipUnreachable ?? shouldSkipUnreachableSandboxBackup(process.env);
  const requireAll = options.requireAll ?? process.env.NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS === "1";
  let backed = 0;
  let failed = 0;
  let skipped = 0;
  let unreachableRunning = 0;
  let notRunningSkipped = 0;
  const strandedOrphans: string[] = [];
  const backupRegisteredSandbox = async (sb: (typeof sandboxes)[number]): Promise<void> => {
    // A registered docker-driver sandbox whose container is merely stopped is
    // backupable: start it for the duration of the backup and return it to
    // its stopped state after (#6500). Anything else that is not Ready keeps
    // the existing skip (and, under installer-strict mode, the #6114 gate).
    let result: sandboxState.BackupResult | null = null;
    let orphanManifestMessage: string | null = null;
    let mutationLockError: unknown;
    let mutationLockFailed = false;
    const attempt = await backupSandboxWithinShieldsWindow(
      sb.name,
      !readyNames.has(sb.name),
      (startedForBackup) =>
        startedForBackup
          ? backupStartedSandboxState(sb.name)
          : snapshotBackup.backupSandboxStateWithManagedAuthority(
              sb.name,
              {},
              {
                getSandbox: registry.getSandbox,
              },
            ),
    );
    if (attempt.stoppedContainerUnavailable) {
      if (orphanNames.has(sb.name) && isSandboxContainerDefinitivelyAbsent(sb.name)) {
        // Tracked separately from `skipped` so the strict gate stays
        // untripped: there is nothing to back up and nothing to start.
        strandedOrphans.push(sb.name);
        return;
      }
      console.log(`  ${D}${notRunningBackupSkipMessage(sb.name)}${R}`);
      skipped++;
      notRunningSkipped++;
      return;
    }
    result = attempt.result;
    orphanManifestMessage = attempt.orphanManifestMessage;
    if ("mutationLockError" in attempt) {
      mutationLockError = attempt.mutationLockError;
      mutationLockFailed = true;
    }
    if (mutationLockFailed) {
      const detail =
        mutationLockError instanceof Error ? mutationLockError.message : String(mutationLockError);
      console.error(`  ${RD}✗${R} ${sb.name}: backup failed (mutation lock: ${detail})`);
      failed++;
      return;
    }
    if (!attempt.shieldsWindowOpened) {
      console.error(`  ${RD}✗${R} ${sb.name}: backup failed (could not safely unlock shields)`);
      failed++;
      return;
    }
    if (orphanManifestMessage) {
      console.log(`  ${YW}⚠${R} Skipped '${sb.name}' (orphan manifest): ${orphanManifestMessage}`);
      skipped++;
      return;
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
          return;
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
  };
  for (const sb of sandboxes) {
    await backupRegisteredSandbox(sb);
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
    const observedOnRecheck = new Set(confirmation.sandboxes.map((sandbox) => sandbox.name));
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
  const purposeLabel = purpose === "pre-uninstall" ? "Pre-uninstall" : "Pre-upgrade";
  console.log(
    `  ${purposeLabel} backup: ${backed} backed up, ${failed} failed, ${skipped} skipped`,
  );
  const strictRetry =
    purpose === "pre-uninstall"
      ? "rerun the original uninstall command"
      : `run '${CLI_NAME} backup-all' again`;
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
          `  Strict ${purpose} backup cannot skip these sandboxes. Restore their gateway health, then ${strictRetry}.`,
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
      `  Strict ${purpose} backup requires every registered sandbox to be backed up; ${skipped} sandbox(es) were skipped.`,
    );
    if (notRunningSkipped > 0) {
      console.error(
        `  ${notRunningSkipped} skipped sandbox(es) were not running. Start each sandbox/container, then ${
          purpose === "pre-uninstall"
            ? "rerun the original uninstall command"
            : `rerun the installer or '${CLI_NAME} backup-all'`
        }.`,
      );
    }
    console.error("  Resolve each skipped sandbox using its reason above and retry.");
  }
  if (failed > 0 || (requireAll && skipped > 0)) process.exit(1);
}

export async function garbageCollectImages(
  options: string[] | GarbageCollectImagesOptions = {},
): Promise<void> {
  return withHermesPortableMaintenanceAdmission("gc", () =>
    garbageCollectImagesWithoutPortableAuthority(options),
  );
}

async function garbageCollectImagesWithoutPortableAuthority(
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
