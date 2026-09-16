// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Gateway-built sandbox images (openshell sandbox create). */
export const SANDBOX_FROM_IMAGE_REPO = "openshell/sandbox-from";
/**
 * Locally prebuilt sandbox images, tagged by the docker-driver-gateway path
 * (Linux, or macOS on Apple Silicon — see isLinuxDockerDriverGatewayEnabled).
 */
export const LOCAL_SANDBOX_IMAGE_REPO = "nemoclaw-sandbox-local";
// Registry clients and image references must use the same IPv4 loopback authority.
export const PORTABLE_REGISTRY_HOST = "127.0.0.1";
export const PORTABLE_REGISTRY_PORT = 5000;
export const PORTABLE_LOCAL_REGISTRY = `${PORTABLE_REGISTRY_HOST}:${PORTABLE_REGISTRY_PORT}`;
export const PORTABLE_LOCAL_SANDBOX_IMAGE_REPO = `${PORTABLE_LOCAL_REGISTRY}/${LOCAL_SANDBOX_IMAGE_REPO}`;

/**
 * Every Docker repository that can hold a sandbox image. Any orphan sweep
 * (`nemoclaw gc`) must enumerate all of them: locally prebuilt sandboxes are
 * tagged under LOCAL_SANDBOX_IMAGE_REPO, not the gateway-side
 * SANDBOX_FROM_IMAGE_REPO, so scanning only the latter left local orphans
 * invisible to gc (#6301).
 */
export const SANDBOX_IMAGE_REPOS = [
  SANDBOX_FROM_IMAGE_REPO,
  LOCAL_SANDBOX_IMAGE_REPO,
  PORTABLE_LOCAL_SANDBOX_IMAGE_REPO,
  // Keep images from earlier Portable versions visible to orphan cleanup.
  `localhost:5000/${LOCAL_SANDBOX_IMAGE_REPO}`,
] as const;

const BUILT_SANDBOX_IMAGE_RE = /Built image (openshell\/sandbox-from:\d+)/;

export function resolveSandboxImageTagFromCreateOutput(
  output: string,
  buildId: string,
  warn: (message: string) => void = console.warn,
): string {
  const builtImageMatch = output.match(BUILT_SANDBOX_IMAGE_RE);
  if (builtImageMatch?.[1]) {
    return builtImageMatch[1];
  }

  warn(
    "  Warning: could not parse image tag from build output; imageTag may be stale. Run 'nemoclaw gc' if destroy fails.",
  );
  return `${SANDBOX_FROM_IMAGE_REPO}:${buildId}`;
}
