// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess maintenance tests. */

import { prompt as askPrompt } from "./credentials";
import { dockerListImagesFormat, dockerRmi } from "./docker";
import { captureOpenshell } from "./openshell-runtime";
import * as registry from "./registry";
import { parseLiveSandboxNames } from "./runtime-recovery";
import * as sandboxState from "./sandbox-state";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";
const YW = useColor ? "\x1b[1;33m" : "";

export function backupAll(): void {
  const { sandboxes } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    console.log("  No sandboxes registered. Nothing to back up.");
    return;
  }

  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  const liveNames = parseLiveSandboxNames(liveList.output || "");

  let backed = 0;
  let failed = 0;
  let skipped = 0;
  for (const sb of sandboxes) {
    if (!liveNames.has(sb.name)) {
      console.log(`  ${D}Skipping '${sb.name}' (not running)${R}`);
      skipped++;
      continue;
    }
    console.log(`  Backing up '${sb.name}'...`);
    const result = sandboxState.backupSandboxState(sb.name);
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

export async function garbageCollectImages(args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes") || args.includes("--force");

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

  const allImages = imagesOutput
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const [tag, size] = line.split("\t");
      return { tag, size: size || "unknown" };
    });

  if (allImages.length === 0) {
    console.log("  No sandbox images found on the host.");
    return;
  }

  const registeredTags = new Set();
  const { sandboxes } = registry.listSandboxes();
  for (const sb of sandboxes) {
    if (sb.imageTag) registeredTags.add(sb.imageTag);
  }

  const orphans = allImages.filter(
    (img: { tag: string; size: string }) => !registeredTags.has(img.tag),
  );

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
