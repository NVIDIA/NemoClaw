// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROOT } from "../runner";
import {
  buildLocalBaseTag,
  defaultOpenclawBaseDockerfile,
  resolveSandboxBaseImage,
  OPENCLAW_SANDBOX_BASE_IMAGE as SANDBOX_BASE_IMAGE,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { getInstalledOpenshellVersion } from "./openshell-version";

/**
 * Resolve a compatible sandbox-base image and pin it to a repo digest when
 * possible. PR-branch validation tries the nearest release tag before
 * source-SHA or latest; an unavailable or incompatible nearest release tag
 * requires a local Dockerfile.base build instead of falling through to a
 * mutable tag.
 */
export function pullAndResolveBaseImageDigest(
  options: {
    requireOpenshellSandboxAbi?: boolean;
    resolutionHint?: SandboxBaseImageResolutionMetadata | null;
    forceRefresh?: boolean;
  } = {},
): {
  digest: string | null;
  ref: string;
  source?: string;
  glibcVersion?: string | null;
  metadata?: SandboxBaseImageResolutionMetadata;
} | null {
  return resolveSandboxBaseImage({
    imageName: SANDBOX_BASE_IMAGE,
    dockerfilePath: defaultOpenclawBaseDockerfile(ROOT),
    localTag: buildLocalBaseTag("nemoclaw-sandbox-base-local", ROOT),
    envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
    label: "OpenClaw sandbox base image",
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    resolutionHint: options.resolutionHint,
    forceRefresh: options.forceRefresh,
    rootDir: ROOT,
  });
}

export function getStableGatewayImageRef(versionOutput: string | null = null): string | null {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}
