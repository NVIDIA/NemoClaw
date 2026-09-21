// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../fixtures/clients/command.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { reviewedOldInstallerProfile } from "./openshell-gateway-upgrade-old-installer.ts";

const NON_INTERACTIVE_INSTALLER_ARGS = ["--non-interactive", "--yes-i-accept-third-party-software"];
const GATEWAY_VOLUME_PREFIX = "openshell-cluster-nemoclaw";
const MANAGED_IMAGE_QUALIFICATION_ENV_KEYS = [
  "E2E_MANAGED_IMAGE_REVISION",
  "E2E_MANAGED_IMAGE_COHORT_RECEIPT",
  "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG",
  "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON",
  "NEMOCLAW_E2E_MANAGED_IMAGE_REVISION",
] as const;
export const GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS = 35 * 60_000;

export async function captureGatewayUpgradeFailureDiagnostics(
  exitCode: number | null,
  capture: (() => Promise<void>) | undefined,
): Promise<void> {
  if (exitCode !== 0) await capture?.();
}

export interface LegacyGatewayUpgradeFixture {
  nemoclawRef: string;
  nemoclawCommit: string;
  installerSha256: string;
  openShellVersion: string;
  openclawVersion: string;
  sandboxBaseImageRef: string;
}

export function validateLegacyGatewayUpgradeFixture(fixture: LegacyGatewayUpgradeFixture): void {
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
      `NEMOCLAW_OLD_INSTALLER_SHA256 must match the reviewed descriptor's lowercase SHA-256 digest; got ${fixture.installerSha256}`,
    );
  }
  if (
    !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(fixture.openclawVersion) ||
    !/^\d+\.\d+\.\d+$/.test(fixture.openShellVersion)
  ) {
    throw new Error(
      `NEMOCLAW_OLD_OPENCLAW_VERSION and NEMOCLAW_OLD_OPENSHELL_VERSION must match the reviewed descriptor; got ${fixture.openclawVersion}/${fixture.openShellVersion}`,
    );
  }
  const reviewedFixture = reviewedOldInstallerProfile(fixture);
  const sandboxBaseDigest = fixture.sandboxBaseImageRef.match(
    /^[^@\s]+@sha256:([0-9a-f]{64})$/,
  )?.[1];
  if (
    fixture.sandboxBaseImageRef !== reviewedFixture.sandboxBaseImageRef ||
    (reviewedFixture.sandboxBaseImageRef !== "" && !sandboxBaseDigest)
  ) {
    throw new Error(
      `NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF must match the reviewed descriptor's workload path; got ${fixture.sandboxBaseImageRef}`,
    );
  }
}

/** Collect both read-only probes without replacing an installer failure. */
export async function captureGatewayUpgradeProbeEvidence(
  sandboxName: string,
  capture: (name: string, args: readonly string[]) => Promise<Pick<ShellProbeResult, "exitCode">>,
): Promise<boolean> {
  const probes = [
    ["get", ["sandbox", "get", "-g", "nemoclaw", sandboxName]],
    ["list", ["sandbox", "list", "-g", "nemoclaw", "-o", "json"]],
  ] as const;
  const results = await Promise.allSettled(probes.map(async ([name, args]) => capture(name, args)));
  return results.every((result) => result.status === "fulfilled" && result.value.exitCode === 0);
}

/** Accept recovery only when the command, listener, and restored sandbox checks all succeed. */
export function gatewayUpgradeRecoverySucceeded(
  recovery: Pick<ShellProbeResult, "exitCode">,
  forward: { readonly valid: boolean },
  stateChecks: readonly Pick<ShellProbeResult, "exitCode">[],
): boolean {
  return (
    recovery.exitCode === 0 && forward.valid && stateChecks.every((result) => result.exitCode === 0)
  );
}

/** Accept credential non-exposure only when both inspections complete with no match. */
export function gatewayCredentialNonExposureScript(
  credential: string,
  managedPaths: readonly string[] = [
    "/sandbox/.openclaw/openclaw.json",
    "/sandbox/.openclaw/agents",
  ],
): string {
  const quotedCredential = shellQuote(credential);
  const quotedManagedPaths = managedPaths.map(shellQuote).join(" ");
  return `env | grep -qF -- ${quotedCredential}
environment_status=$?
case "$environment_status" in
  1) ;;
  0) printf '%s\\n' 'ERROR: gateway credential is exposed in the sandbox environment' >&2; exit 1 ;;
  *) printf 'ERROR: sandbox environment credential inspection failed (grep exit %s)\\n' "$environment_status" >&2; exit "$environment_status" ;;
esac
grep -rqF -- ${quotedCredential} ${quotedManagedPaths}
managed_files_status=$?
case "$managed_files_status" in
  1) ;;
  0) printf '%s\\n' 'ERROR: gateway credential is exposed in managed OpenClaw files' >&2; exit 1 ;;
  *) printf 'ERROR: managed OpenClaw credential inspection failed (grep exit %s)\\n' "$managed_files_status" >&2; exit "$managed_files_status" ;;
esac`;
}

export function oldGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS, "--fresh"];
}

export function currentGatewayUpgradeInstallerArgs(installer: string): string[] {
  return [installer, ...NON_INTERACTIVE_INSTALLER_ARGS];
}

/** Override the historical Dockerfile base only when the reviewed fixture pins one. */
export function legacyGatewayUpgradeBaseImageOverrideEnabled(baseImageRef: string): boolean {
  return baseImageRef.length > 0;
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

/** Keep the upgrade fixture on its explicit Dockerfile source across managed-image CI lanes. */
export function isolateGatewayUpgradeFixtureEnv(
  environment: NodeJS.ProcessEnv,
  workloadSource: "" | "local-dockerfile",
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...environment, E2E_WORKLOAD_SOURCE: workloadSource };
  for (const key of MANAGED_IMAGE_QUALIFICATION_ENV_KEYS) delete isolated[key];
  return isolated;
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
