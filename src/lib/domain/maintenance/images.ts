// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SandboxImageRow = { tag: string; size: string };

export function parseSandboxImageRows(imagesOutput: string): SandboxImageRow[] {
  const rows: SandboxImageRow[] = [];
  for (const rawLine of imagesOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [tag, size] = line.split("\t");
    rows.push({ tag, size: size || "unknown" });
  }
  return rows;
}

export function getRegisteredImageTags(
  sandboxes: Array<{ imageTag?: string | null }>,
): Set<string> {
  const registeredTags = new Set<string>();
  for (const sandbox of sandboxes) {
    if (sandbox.imageTag) registeredTags.add(sandbox.imageTag);
  }
  return registeredTags;
}

export function findOrphanedSandboxImages(
  images: SandboxImageRow[],
  sandboxes: Array<{ imageTag?: string | null }>,
): SandboxImageRow[] {
  const registeredTags = getRegisteredImageTags(sandboxes);
  const orphans: SandboxImageRow[] = [];
  for (const image of images) {
    if (!registeredTags.has(image.tag)) {
      orphans.push(image);
    }
  }
  return orphans;
}
