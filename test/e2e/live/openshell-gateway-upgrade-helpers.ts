// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";

const COMMON_INSTALLER_ARGS = ["--non-interactive", "--yes-i-accept-third-party-software"];
const GATEWAY_VOLUME_PREFIX = "openshell-cluster-nemoclaw";

export interface LegacyGatewayUpgradeFixture {
  nemoclawRef: string;
  nemoclawCommit: string;
  installerSha256: string;
  openclawVersion: string;
  sandboxBaseImageRef: string;
}

export function validateLegacyGatewayUpgradeFixture(fixture: LegacyGatewayUpgradeFixture): {
  sandboxBaseDigest: string;
} {
  if (!/^v\d+\.\d+\.\d+$/.test(fixture.nemoclawRef)) {
    throw new Error(`NEMOCLAW_OLD_NEMOCLAW_REF must be a release tag; got ${fixture.nemoclawRef}`);
  }
  if (!/^[0-9a-f]{40}$/.test(fixture.nemoclawCommit)) {
    throw new Error(
      `NEMOCLAW_OLD_NEMOCLAW_COMMIT must be a full lowercase commit SHA; got ${fixture.nemoclawCommit}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(fixture.installerSha256)) {
    throw new Error(
      `NEMOCLAW_OLD_INSTALLER_SHA256 must be a lowercase SHA-256 digest; got ${fixture.installerSha256}`,
    );
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(fixture.openclawVersion)) {
    throw new Error(
      `NEMOCLAW_OLD_OPENCLAW_VERSION must use the YYYY.M.D release format; got ${fixture.openclawVersion}`,
    );
  }
  const sandboxBaseDigest = fixture.sandboxBaseImageRef.match(
    /^[^@\s]+@sha256:([0-9a-f]{64})$/,
  )?.[1];
  if (!sandboxBaseDigest) {
    throw new Error(
      `NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF must be digest-pinned; got ${fixture.sandboxBaseImageRef}`,
    );
  }
  return { sandboxBaseDigest };
}

export function oldGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...COMMON_INSTALLER_ARGS, "--fresh"];
}

export function currentGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...COMMON_INSTALLER_ARGS];
}

export function upgradeGatewayCleanupScript(pidFile: string): string {
  return `if command -v openshell >/dev/null 2>&1; then
  openshell gateway remove nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy -g nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy >/dev/null 2>&1 \\
    || true
fi
volume_prefix=${GATEWAY_VOLUME_PREFIX}
gateway_volumes="$(docker volume ls -q --filter "name=\${volume_prefix}")"
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  case "$volume" in
    ${GATEWAY_VOLUME_PREFIX}|${GATEWAY_VOLUME_PREFIX}-*)
      printf 'Removing stale OpenShell gateway volume %s\\n' "$volume"
      docker volume rm "$volume" >/dev/null
      ;;
  esac
done <<<"$gateway_volumes"
rm -f ${shellQuote(pidFile)}`;
}
