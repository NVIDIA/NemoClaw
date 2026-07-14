// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { extractBuiltImageRef } from "../../../src/lib/build-context";
import {
  LOCAL_SANDBOX_IMAGE_REPO,
  SANDBOX_FROM_IMAGE_REPO,
} from "../../../src/lib/domain/sandbox/image-tag";

export interface RebuildHermesRegistryImageState {
  imageTag: string;
  fromDockerfile: null;
}

export async function cleanupTrackedRebuildHermesImage(
  imageTag: string | null,
  remove: (imageTag: string) => Promise<void>,
): Promise<void> {
  if (imageTag !== null) await remove(imageTag);
}

export function requireRebuildHermesInitialImageTag(value: unknown, sandboxName: string): string {
  const prefix = `${LOCAL_SANDBOX_IMAGE_REPO}:${sandboxName}-`;
  const imageTag = typeof value === "string" ? value : "";
  const buildPart = imageTag.startsWith(prefix) ? imageTag.slice(prefix.length) : "";
  if (!/^\d+$/.test(buildPart)) {
    throw new Error(
      `initial Hermes fixture imageTag must be an owned ${prefix}<build> tag; got ${imageTag || "<missing>"}`,
    );
  }
  return imageTag;
}

export function rebuildHermesRegistryImageState(
  createOutput: string,
): RebuildHermesRegistryImageState {
  const imageTag = extractBuiltImageRef(createOutput);
  const prefix = `${SANDBOX_FROM_IMAGE_REPO}:`;
  const buildId = imageTag?.startsWith(prefix) ? imageTag.slice(prefix.length) : "";
  if (!imageTag || !/^\d+$/.test(buildId)) {
    throw new Error(
      `old Hermes sandbox create must report an exact ${prefix}<build-id> image tag; got ${imageTag ?? "<missing>"}`,
    );
  }
  return { imageTag, fromDockerfile: null };
}
