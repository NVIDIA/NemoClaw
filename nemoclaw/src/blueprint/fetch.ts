// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blueprint artifact fetching — download versioned blueprint archives from
 * an OCI registry or GitHub release, extract to local cache.
 */

import type { BlueprintManifest, ResolvedBlueprint } from "./resolve.js";
import { getCacheDir, getCachedBlueprintPath, readCachedManifest } from "./resolve.js";

/**
 * Fetch a blueprint artifact from a remote registry and cache it locally.
 *
 * Intended flow:
 *   1. Resolve "latest" to a concrete version tag via registry API
 *   2. Download the blueprint tarball from the OCI registry or GitHub release
 *   3. Verify digest (SHA-256) against the registry manifest
 *   4. Check compatibility metadata (min OpenShell/OpenClaw versions)
 *   5. Extract to local cache dir
 *   6. Return resolved blueprint
 *
 * For now, blueprints must be placed manually in the cache directory.
 */
export function fetchBlueprint(registry: string, version: string): Promise<ResolvedBlueprint> {
  return Promise.reject(
    new Error(
      `Blueprint fetch not yet implemented. ` +
        `Registry: ${registry}, Version: ${version}. ` +
        `Place blueprint files in ${getCacheDir()}/<version>/ for local development.`,
    ),
  );
}

/**
 * Resolve a "latest" version tag to a concrete version string by querying
 * the registry's tag list or release API.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- stub; will use await once registry API is implemented
export async function resolveLatestVersion(registry: string): Promise<string> {
  // Future: query OCI tag list or GitHub releases API
  void registry;
  throw new Error("Latest version resolution not yet implemented.");
}

/**
 * Download and extract a blueprint tarball into the local cache directory.
 * Returns the local path where the blueprint was extracted.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- stub; will use await once HTTP fetch is implemented
export async function downloadAndCache(
  registry: string,
  version: string,
): Promise<{ localPath: string; manifest: BlueprintManifest }> {
  // Future: HTTP fetch + tar extract + manifest parse
  void registry;
  const localPath = getCachedBlueprintPath(version);
  const manifest = readCachedManifest(version);
  if (!manifest) {
    throw new Error(`Failed to read manifest after download for version ${version}`);
  }
  return { localPath, manifest };
}
