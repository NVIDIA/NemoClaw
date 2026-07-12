// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface XattrAclCapabilityProbe {
  xattr: boolean;
  acl: boolean;
}

/**
 * Requires real xattr + ACL support on the sandbox's guarded-state-directory
 * filesystem: fails in CI (where support is mandatory) or skips locally
 * (where the host filesystem may not back it).
 */
export function requireXattrAclCapability(
  capability: XattrAclCapabilityProbe,
  skip: (reason: string) => never,
): void {
  if (capability.xattr && capability.acl) return;
  const note = `filesystem backing the guarded state directory lacks required capability: ${JSON.stringify(capability)}`;
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(
      `xattr/ACL support is required in CI for state-dir-guard xattr/ACL live E2E: ${note}`,
    );
  }
  skip(note);
}

/**
 * Requires the host `docker` CLI to be reachable: fails in CI (where Docker
 * is mandatory) or skips locally (where a contributor's sandbox may not have
 * it). Takes the already-executed probe result rather than running Docker
 * itself, so callers keep using their own command-execution path (e.g. the
 * shared HostCliClient) instead of a separate probing mechanism.
 */
export function requireDockerAvailable(
  dockerInfo: { exitCode: number | null },
  describeResult: () => string,
  testLabel: string,
  skip: (reason: string) => never,
): void {
  if (dockerInfo.exitCode === 0) return;
  const note = `Docker is required for ${testLabel}: ${describeResult()}`;
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error(note);
  }
  skip(note);
}
