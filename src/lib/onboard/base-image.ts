// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker";
import { ROOT } from "../runner";
import {
  buildLocalBaseTag,
  defaultOpenclawBaseDockerfile,
  resolveSandboxBaseImage,
  OPENCLAW_SANDBOX_BASE_IMAGE as SANDBOX_BASE_IMAGE,
  type SandboxBaseImageResolutionMetadata,
} from "../sandbox-base-image";
import { getInstalledOpenshellVersion } from "./openshell-version";

const OPENCLAW_SECURITY_INVENTORY_PROBE_OK = "nemoclaw-security-inventory-ok";

/**
 * Reject a published or cached OpenClaw base that predates the immutable
 * security package inventory consumed by the completed-image verification.
 * Accepting that base only defers the mismatch to the last Dockerfile layer,
 * after the expensive final image has already been built.
 */
export function openClawBaseImageHasSecurityInventory(imageRef: string): boolean {
  const output = dockerCapture(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--entrypoint",
      "/bin/sh",
      imageRef,
      "-c",
      [
        "set -eu",
        "security_inventory=/usr/local/share/nemoclaw/security-packages.txt",
        'arch="$(dpkg --print-architecture)"',
        'test -f "$security_inventory"',
        'test ! -L "$security_inventory"',
        `test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"`,
        `printf '%s\\n' "architecture=$arch" "libexpat1=2.8.2-1" "libonig5=6.9.9-1+b1" "libjq1=1.8.2-1" "jq=1.8.2-1" "vim-common=2:9.2.0782-1" "vim-tiny=2:9.2.0782-1" | cmp -s - "$security_inventory"`,
        `printf '%s\\n' "${OPENCLAW_SECURITY_INVENTORY_PROBE_OK}"`,
      ].join("; "),
    ],
    { ignoreError: true, timeout: 20_000 },
  );
  return output.trim() === OPENCLAW_SECURITY_INVENTORY_PROBE_OK;
}

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
    validateImage: openClawBaseImageHasSecurityInventory,
    validationDescription: "the immutable security package inventory",
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
