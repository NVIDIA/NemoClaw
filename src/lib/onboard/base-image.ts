// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROOT } from "../runner";
import {
  buildLocalBaseTag,
  defaultOpenclawBaseDockerfile,
  resolveSandboxBaseImage,
  OPENCLAW_SANDBOX_BASE_IMAGE as SANDBOX_BASE_IMAGE,
} from "../sandbox-base-image";
import { getInstalledOpenshellVersion } from "./openshell-version";

/**
 * Resolve a compatible sandbox-base image and pin it to a repo digest when
 * possible. PR-branch validation first tries a source-SHA tag, then latest,
 * and finally a local Dockerfile.base build when the OpenShell Docker driver
 * requires a newer glibc than the published image provides.
 */
export function pullAndResolveBaseImageDigest(
  options: { requireOpenshellSandboxAbi?: boolean } = {},
): { digest: string | null; ref: string; source?: string; glibcVersion?: string | null } | null {
  return resolveSandboxBaseImage({
    imageName: SANDBOX_BASE_IMAGE,
    dockerfilePath: defaultOpenclawBaseDockerfile(ROOT),
    localTag: buildLocalBaseTag("nemoclaw-sandbox-base-local", ROOT),
    envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
    label: "OpenClaw sandbox base image",
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    rootDir: ROOT,
  });
}

export function getStableGatewayImageRef(versionOutput: string | null = null): string | null {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}
