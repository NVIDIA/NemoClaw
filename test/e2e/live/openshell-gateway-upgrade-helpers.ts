// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { reviewedOldInstallerProfile } from "./openshell-gateway-upgrade-old-installer.ts";
import {
  openClawAgentResponseRecord,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";

/** A successful RPC transport can still carry a failed agent run. */
export function gatewayUpgradeAgentResponseIsSuccessful(raw: string): boolean {
  const responses = parseOpenClawJsonDocuments(raw).filter(
    (document) => openClawAgentResponseRecord(document) !== null,
  );
  return (
    responses.length > 0 &&
    responses.every((document) => (document as { status?: unknown }).status === "ok")
  );
}

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

/** The pinned legacy CLI validates the SSH process against its sandbox and port. */
export function legacyGatewayForwardIdentity(
  listing: Pick<ShellProbeResult, "exitCode" | "stdout" | "signal" | "timedOut">,
  listener: Pick<ShellProbeResult, "exitCode" | "stdout" | "signal" | "timedOut">,
  sandboxName: string,
  port: string,
): string | null {
  if (
    [listing, listener].some((result) => result.exitCode !== 0 || result.signal || result.timedOut)
  )
    return null;
  const rows = stripVTControlCharacters(listing.stdout)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[0] === sandboxName && fields[2] === port);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const pid = row[3] ?? "";
  if (
    row.length !== 5 ||
    row[4] !== "running" ||
    !/^[1-9]\d*$/.test(pid) ||
    !Number.isSafeInteger(Number(pid))
  )
    return null;
  const listeners = [...new Set(listener.stdout.trim().split(/\s+/))];
  return listeners.length === 1 && listeners[0] === pid ? row.join("\t") : null;
}

export async function captureLegacyGatewayForward(
  host: Pick<HostCliClient, "command" | "openshellCommandPath">,
  sandboxName: string,
  port: string,
  env: NodeJS.ProcessEnv,
  phase: string,
): Promise<{ identity: string | null; output: string }> {
  const [listing, listener] = await Promise.all([
    host.command(host.openshellCommandPath, ["forward", "list"], {
      artifactName: `${phase}-dashboard-forward-list`,
      env,
      timeoutMs: 15_000,
    }),
    host.command("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      artifactName: `${phase}-dashboard-forward-listener`,
      env,
      timeoutMs: 15_000,
    }),
  ]);
  return {
    identity: legacyGatewayForwardIdentity(listing, listener, sandboxName, port),
    output: [listing, listener].map(resultText).join("\n"),
  };
}

type ForwardObservation = Pick<ShellProbeResult, "exitCode" | "stdout" | "signal" | "timedOut">;

function listenerPid(observation: ForwardObservation): string | null {
  const pids = [...new Set(observation.stdout.trim().split(/\s+/))];
  return observation.exitCode === 0 &&
    !observation.signal &&
    !observation.timedOut &&
    pids.length === 1 &&
    /^[1-9]\d*$/.test(pids[0]!)
    ? pids[0]!
    : null;
}

/** The v0.0.123 fixture launches ForwardTcp directly, outside the SSH forward registry. */
export function legacyGatewayServiceForwardIdentity(
  probes: readonly ForwardObservation[],
  sandboxName: string,
  port: string,
): string | null {
  if (
    probes.length !== 8 ||
    probes.some((probe) => probe.exitCode !== 0 || probe.signal || probe.timedOut)
  )
    return null;
  const [
    before,
    command,
    statBefore,
    executable,
    expectedExecutable,
    commandLine,
    statAfter,
    after,
  ] = probes;
  const pid = listenerPid(before!);
  if (!pid || listenerPid(after!) !== pid) return null;
  const processStart = (raw: string): string | null => {
    const end = raw.lastIndexOf(") ");
    if (!raw.startsWith(`${pid} (`) || end < 0) return null;
    const fields = raw
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    return fields[0] !== "Z" && /^[1-9]\d*$/.test(fields[19] ?? "") ? fields[19]! : null;
  };
  const start = processStart(statBefore!.stdout);
  const binary = executable!.stdout.trim();
  const commandPath = command!.stdout.trim();
  const argv = commandLine!.stdout.split("\0");
  if (argv.at(-1) === "") argv.pop();
  const expected = [
    commandPath,
    "--gateway",
    "nemoclaw",
    "--workspace",
    "default",
    "forward",
    "service",
    sandboxName,
    "--target-port",
    port,
    "--target-host",
    "127.0.0.1",
    "--local",
    `127.0.0.1:${port}`,
  ];
  if (
    !start ||
    processStart(statAfter!.stdout) !== start ||
    !commandPath.startsWith("/") ||
    !binary.startsWith("/") ||
    binary !== expectedExecutable!.stdout.trim() ||
    argv.length !== expected.length ||
    argv.some((value, index) => value !== expected[index])
  )
    return null;
  return `${pid}\t${start}\t${binary}\t${JSON.stringify(argv)}`;
}

export async function captureLegacyGatewayServiceForward(
  host: Pick<HostCliClient, "command" | "openshellCommandPath">,
  sandboxName: string,
  port: string,
  env: NodeJS.ProcessEnv,
  phase: string,
): Promise<{ identity: string | null; output: string }> {
  const probe = (suffix: string, command: string, args: string[]) =>
    host.command(command, args, {
      artifactName: `${phase}-dashboard-service-${suffix}`,
      env,
      timeoutMs: 15_000,
    });
  const [before, command] = await Promise.all([
    probe("listener-before", "lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]),
    probe("command", "which", [host.openshellCommandPath]),
  ]);
  const pid = listenerPid(before);
  const commandPath = command.stdout.trim();
  if (
    !pid ||
    command.exitCode !== 0 ||
    command.signal ||
    command.timedOut ||
    !commandPath.startsWith("/")
  ) {
    return { identity: null, output: [before, command].map(resultText).join("\n") };
  }
  const statBefore = await probe("stat-before", "cat", [`/proc/${pid}/stat`]);
  const [executable, expectedExecutable, commandLine] = await Promise.all([
    probe("executable", "readlink", ["-f", `/proc/${pid}/exe`]),
    probe("expected-executable", "readlink", ["-f", commandPath]),
    probe("argv", "cat", [`/proc/${pid}/cmdline`]),
  ]);
  const [statAfter, after] = await Promise.all([
    probe("stat-after", "cat", [`/proc/${pid}/stat`]),
    probe("listener-after", "lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]),
  ]);
  const probes = [
    before,
    command,
    statBefore,
    executable,
    expectedExecutable,
    commandLine,
    statAfter,
    after,
  ];
  return {
    identity: legacyGatewayServiceForwardIdentity(probes, sandboxName, port),
    output: probes.map(resultText).join("\n"),
  };
}

/** Apply path spelling at the installer boundary, after login-shell startup. */
export function gatewayUpgradeInstallerCommand(args: readonly string[], home?: string): string {
  const prefix = home
    ? `HOME=${shellQuote(home)} XDG_CONFIG_HOME=${shellQuote(`${home}/.config//`)} `
    : "";
  return `${prefix}bash ${args.map(shellQuote).join(" ")}`;
}

/** Prepare the disposable runner's user manager before the historical install. */
export async function prepareGatewayUpgradeUserManager(
  host: Pick<HostCliClient, "command">,
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const result = await host.command(
    "sudo",
    ["-n", "systemctl", "start", `user@${process.getuid?.()}.service`],
    {
      artifactName: "prepare-systemd-user-manager",
      env,
      timeoutMs: 30_000,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`Cannot prepare the systemd user manager: ${resultText(result)}`);
}

/** Retain real systemd metadata for revision-bound manual verification. */
export async function captureGatewayUpgradeService(
  host: HostCliClient,
  phase: string,
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): Promise<ShellProbeResult | null> {
  if (!enabled) return null;
  return host.command(
    "systemctl",
    [
      "--user",
      "show",
      "nemoclaw-openshell-gateway.service",
      "--property=FragmentPath,ActiveState,MainPID,InvocationID",
    ],
    {
      artifactName: `${phase}-systemd-gateway`,
      env,
      timeoutMs: 30_000,
    },
  );
}

type ServiceObservation = Pick<ShellProbeResult, "exitCode" | "stdout" | "signal" | "timedOut">;
export interface GatewayUpgradeServiceEvidence {
  before: ServiceObservation | null;
  after: ServiceObservation | null;
  expectedFragmentPath: string;
}

function activeServiceInvocation(
  observation: ServiceObservation | null,
  fragmentPath: string,
): string | null {
  if (!observation || observation.exitCode !== 0 || observation.signal || observation.timedOut)
    return null;
  const lines = observation.stdout.trim().split(/\r?\n/);
  const properties = new Map(
    lines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  const invocation = properties.get("InvocationID") ?? "";
  const pid = properties.get("MainPID") ?? "";
  return lines.length === 4 &&
    properties.size === 4 &&
    properties.get("FragmentPath") === fragmentPath &&
    properties.get("ActiveState") === "active" &&
    /^[1-9][0-9]*$/.test(pid) &&
    Number.isSafeInteger(Number(pid)) &&
    /^[0-9a-f]{32}$/.test(invocation) &&
    invocation !== "0".repeat(32)
    ? invocation
    : null;
}

function gatewayServiceWasReplaced(evidence: GatewayUpgradeServiceEvidence): boolean {
  const before = activeServiceInvocation(evidence.before, evidence.expectedFragmentPath);
  const after = activeServiceInvocation(evidence.after, evidence.expectedFragmentPath);
  return before !== null && after !== null && before !== after;
}

/** A denied cutover must leave the same active gateway service in place. */
export function gatewayServiceWasPreserved(evidence: GatewayUpgradeServiceEvidence): boolean {
  const before = activeServiceInvocation(evidence.before, evidence.expectedFragmentPath);
  const after = activeServiceInvocation(evidence.after, evidence.expectedFragmentPath);
  return before !== null && before === after;
}

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
  service?: GatewayUpgradeServiceEvidence,
): boolean {
  return (
    recovery.exitCode === 0 &&
    forward.valid &&
    stateChecks.every((result) => result.exitCode === 0) &&
    (service === undefined || gatewayServiceWasReplaced(service))
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
