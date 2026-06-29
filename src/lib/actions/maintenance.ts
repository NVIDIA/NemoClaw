// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerListImagesFormat, dockerRmi } from "../adapters/docker";
import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../adapters/openshell/gateway-drift";
import { CLI_NAME } from "../cli/branding";
import { prompt as askPrompt } from "../credentials/store";
import {
  type GarbageCollectImagesOptions,
  normalizeGarbageCollectImagesOptions,
} from "../domain/lifecycle/options";
import { findOrphanedSandboxImages, parseSandboxImageRows } from "../domain/maintenance/images";
import {
  captureSandboxListWithGatewayRecovery,
  printSandboxListFailureWithRecoveryContext,
} from "../openshell-sandbox-list";
import { parseReadySandboxNames } from "../runtime-recovery";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";
const YW = useColor ? "\x1b[1;33m" : "";

export async function backupAll(): Promise<void> {
  const { sandboxes } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    console.log("  No sandboxes registered. Nothing to back up.");
    return;
  }

  const preflightIssue = detectOpenShellStateRpcPreflightIssue();
  if (preflightIssue) {
    printOpenShellStateRpcIssue(preflightIssue, {
      action: "backing up registered sandboxes",
      command: `${CLI_NAME} backup-all`,
    });
    process.exit(1);
  }

  const liveListRecovery = await captureSandboxListWithGatewayRecovery();
  const liveList = liveListRecovery.result;
  const resultIssue = detectOpenShellStateRpcResultIssue(liveList);
  if (resultIssue) {
    printOpenShellStateRpcIssue(resultIssue, {
      action: "backing up registered sandboxes",
      command: `${CLI_NAME} backup-all`,
    });
    process.exit(1);
  }
  if (liveList.status !== 0) {
    printSandboxListFailureWithRecoveryContext(liveListRecovery);
    process.exit(liveList.status || 1);
  }
  const readyNames = parseReadySandboxNames(liveList.output || "");

  let backed = 0;
  let failed = 0;
  let skipped = 0;
  for (const sb of sandboxes) {
    if (!readyNames.has(sb.name)) {
      console.log(`  ${D}Skipping '${sb.name}' (not running)${R}`);
      skipped++;
      continue;
    }
    console.log(`  Backing up '${sb.name}'...`);
    let result: sandboxState.BackupResult;
    try {
      result = sandboxState.backupSandboxState(sb.name);
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
      console.log(`  ${YW}⚠${R} Skipped '${sb.name}' (orphan manifest): ${msg}`);
      skipped++;
      continue;
    }
    if (result.success) {
      console.log(
        `  ${G}✓${R} ${sb.name}: ${result.backedUpDirs.length} dirs, ${result.backedUpFiles.length} files → ${result.manifest?.backupPath || "unknown"}`,
      );
      backed++;
    } else {
      const failedItems = [...result.failedDirs, ...result.failedFiles];
      console.error(`  ${RD}✗${R} ${sb.name}: backup failed (${failedItems.join(", ")})`);
      failed++;
    }
  }
  console.log("");
  console.log(`  Pre-upgrade backup: ${backed} backed up, ${failed} failed, ${skipped} skipped`);
  if (backed > 0) {
    console.log(`  Backups stored in: ~/.nemoclaw/rebuild-backups/`);
  }
  if (failed > 0) {
    process.exit(1);
  }
}

export async function garbageCollectImages(
  options: string[] | GarbageCollectImagesOptions = {},
): Promise<void> {
  const normalized = normalizeGarbageCollectImagesOptions(options);
  const dryRun = normalized.dryRun === true;
  const skipConfirm = normalized.yes === true || normalized.force === true;

  let imagesOutput = "";
  try {
    imagesOutput = dockerListImagesFormat(
      "openshell/sandbox-from",
      "{{.Repository}}:{{.Tag}}\t{{.Size}}",
    );
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
