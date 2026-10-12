// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerListImagesFormat, dockerRmi } from "../../adapters/docker";
import { prompt as askPrompt } from "../../credentials/store";
import {
  type GarbageCollectImagesOptions,
  normalizeGarbageCollectImagesOptions,
} from "../../domain/lifecycle/options";
import { findOrphanedSandboxImages, parseSandboxImageRows } from "../../domain/maintenance/images";
import { SANDBOX_IMAGE_REPOS } from "../../domain/sandbox/image-tag";
import {
  listGatewayStateRoots,
  listHostGatewayRegistryEntries,
  resolveHome,
} from "../../state/gateway-registry";
import { withRegistryLockAt } from "../../state/registry/lock";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";
const YW = useColor ? "\x1b[1;33m" : "";

function registeredImages() {
  // Docker images are host-wide, so every gateway registry must protect its tags.
  return listHostGatewayRegistryEntries(resolveHome()).map(({ entry, registryFile }) => {
    const imageTag = entry.imageTag;
    if (
      imageTag !== undefined &&
      imageTag !== null &&
      (typeof imageTag !== "string" || imageTag.trim().length === 0)
    ) {
      throw new Error(
        `Cannot safely inspect ${registryFile}: invalid imageTag for sandbox ${entry.name}`,
      );
    }
    return { imageTag };
  });
}

function withHostRegistryLocks(operation: () => void): void {
  // The caller holds the portable host fence, so this root snapshot remains
  // complete through image deletion.
  const registryFiles = listGatewayStateRoots(resolveHome())
    .filter(({ root }) => fs.existsSync(root))
    .map(({ root }) => path.join(root, "sandboxes.json"))
    .sort();
  function lockNext(index: number): void {
    if (index === registryFiles.length) return operation();
    withRegistryLockAt(registryFiles[index]!, () => lockNext(index + 1));
  }
  lockNext(0);
}

export async function garbageCollectImagesWithoutPortableAuthority(
  options: string[] | GarbageCollectImagesOptions = {},
  withDeletionAdmission: <T>(operation: () => Promise<T> | T) => Promise<T> = async (operation) =>
    await operation(),
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

  const sandboxes = registeredImages();
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

  const approvedTags = new Set(orphans.map(({ tag }) => tag));
  await withDeletionAdmission(async () => {
    // Confirmation may take arbitrarily long. Once it returns, take the host
    // fence first, then refresh both Docker and every gateway registry before
    // acquiring per-root locks and deleting anything.
    let currentImagesOutput = "";
    try {
      currentImagesOutput = SANDBOX_IMAGE_REPOS.map((repo) =>
        dockerListImagesFormat(repo, "{{.Repository}}:{{.Tag}}\t{{.Size}}"),
      ).join("\n");
    } catch {
      console.error("  Failed to re-query Docker images. Is Docker running?");
      process.exit(1);
    }
    const currentImages = parseSandboxImageRows(currentImagesOutput).filter(({ tag }) =>
      approvedTags.has(tag),
    );
    const currentOrphans = findOrphanedSandboxImages(currentImages, registeredImages());
    let removed = 0;
    let failed = 0;
    withHostRegistryLocks(() => {
      // Registry writers that can publish a gateway image also hold the host
      // fence. Per-root locks additionally protect legacy/non-image mutations.
      for (const img of findOrphanedSandboxImages(currentOrphans, registeredImages())) {
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
          const details = String(rmiResult.stderr || rmiResult.stdout || "").trim();
          console.error(`  ${YW}⚠${R} Failed to remove ${img.tag}${details ? `: ${details}` : ""}`);
          failed++;
        }
      }
    });

    console.log("");
    if (removed > 0) console.log(`  ${G}✓${R} Removed ${removed} orphaned image(s).`);
    if (failed > 0) console.log(`  ${YW}⚠${R} Failed to remove ${failed} image(s).`);
    if (failed > 0) process.exit(1);
  });
}
