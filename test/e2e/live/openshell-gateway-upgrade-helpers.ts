// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";
import { REVIEWED_GATEWAY_UPGRADE_FIXTURE } from "../../../tools/e2e/openshell-gateway-upgrade-fixture.mts";
import { reviewedOldInstallerProfile } from "./openshell-gateway-upgrade-old-installer.ts";

const NON_INTERACTIVE_INSTALLER_ARGS = ["--non-interactive", "--yes-i-accept-third-party-software"];
const GATEWAY_VOLUME_PREFIX = "openshell-cluster-nemoclaw";
export const GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS = 35 * 60_000;

export interface LegacyGatewayUpgradeFixture {
  nemoclawRef: string;
  nemoclawCommit: string;
  installerSha256: string;
  openShellVersion: string;
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
  if (
    !/^[0-9a-f]{64}$/.test(fixture.installerSha256) ||
    fixture.installerSha256 !== REVIEWED_GATEWAY_UPGRADE_FIXTURE.installerSha256
  ) {
    throw new Error(
      `NEMOCLAW_OLD_INSTALLER_SHA256 must match the reviewed descriptor's lowercase SHA-256 digest; got ${fixture.installerSha256}`,
    );
  }
  if (
    !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(fixture.openclawVersion) ||
    !/^\d+\.\d+\.\d+$/.test(fixture.openShellVersion) ||
    fixture.openShellVersion !== REVIEWED_GATEWAY_UPGRADE_FIXTURE.openShellVersion
  ) {
    throw new Error(
      `NEMOCLAW_OLD_OPENCLAW_VERSION and NEMOCLAW_OLD_OPENSHELL_VERSION must match the reviewed descriptor; got ${fixture.openclawVersion}/${fixture.openShellVersion}`,
    );
  }
  reviewedOldInstallerProfile(fixture);
  const sandboxBaseDigest = fixture.sandboxBaseImageRef.match(
    /^[^@\s]+@sha256:([0-9a-f]{64})$/,
  )?.[1];
  if (
    !sandboxBaseDigest ||
    fixture.sandboxBaseImageRef !== REVIEWED_GATEWAY_UPGRADE_FIXTURE.sandboxBaseImageRef
  ) {
    throw new Error(
      `NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF must match the reviewed descriptor and use a digest pin; got ${fixture.sandboxBaseImageRef}`,
    );
  }
  return { sandboxBaseDigest };
}

export function oldGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS, "--fresh"];
}

export function currentGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS];
}

export function currentNemoclawUpgradeRef(env: NodeJS.ProcessEnv): string {
  for (const candidate of [
    env.NEMOCLAW_CURRENT_NEMOCLAW_REF,
    env.NEMOCLAW_E2E_EXPECTED_SHA,
    env.GITHUB_SHA,
  ]) {
    if (candidate?.trim()) return candidate.trim();
  }
  return "HEAD";
}

export function legacyGatewayUpgradeHostFirewallOptions(): {
  networkName: string | undefined;
  waitForNetworkMs: number;
} {
  // The historical install creates its network after fetching and building
  // its payload, so keep the parallel probe alive for the full install budget.
  return { networkName: undefined, waitForNetworkMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS };
}

export function throwGatewayUpgradeSetupFailures(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "legacy install and host mock firewall setup failed");
  }
}

export function upgradeGatewayStateCleanupScript(pidFile: string): string {
  return `set -e
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

export function upgradeGatewayCleanupScript(pidFile: string): string {
  return `if command -v openshell >/dev/null 2>&1; then
  openshell gateway remove nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy -g nemoclaw >/dev/null 2>&1 \\
    || openshell gateway destroy >/dev/null 2>&1 \\
    || true
fi
${upgradeGatewayStateCleanupScript(pidFile)}`;
}
