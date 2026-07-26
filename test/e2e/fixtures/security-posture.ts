// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "./clients/sandbox.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

export type SecurityPostureAgent = "hermes" | "openclaw";

export interface SecurityPostureSummary {
  configureGuard: true;
  entrypoint: {
    capBnd: string;
    capEff: string | null;
    dangerousBoundingCapabilities: string[];
    dangerousEffectiveCapabilities: string[];
    noNewPrivs: string | null;
    uid: string;
  };
  hostNonRoot: true;
  rcFilesLocked: true;
  runtimeProxyEnvLocked: true;
  startupLogClean: true;
}

export interface SecurityPostureExpectations {
  droppedBoundingCapabilities: boolean;
  enabled: boolean;
  noNewPrivileges: boolean;
  nonRootEntrypoint: boolean;
}

const DANGEROUS_CAPABILITIES = [
  [21, "CAP_SYS_ADMIN"],
  [19, "CAP_SYS_PTRACE"],
  [13, "CAP_NET_RAW"],
  [10, "CAP_NET_BIND_SERVICE"],
  [1, "CAP_DAC_OVERRIDE"],
] as const;

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function probeEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function requireSuccess(label: string, result: ShellProbeResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}:\n${resultText(result)}`);
  }
}

function statusField(status: string, field: string): string | null {
  const match = status.match(new RegExp(`^${field}:\\s+([^\\s]+)`, "m"));
  return match?.[1] ?? null;
}

export function dangerousCapabilities(capabilityHex: string | null): string[] {
  if (!capabilityHex || !/^[0-9a-f]+$/iu.test(capabilityHex)) return [];
  const value = BigInt(`0x${capabilityHex}`);
  return DANGEROUS_CAPABILITIES.filter(([bit]) => (value & (1n << BigInt(bit))) !== 0n).map(
    ([, name]) => name,
  );
}

export function securityPostureEnabled(): boolean {
  return securityPostureExpectations().enabled;
}

export function securityPostureExpectations(
  env: NodeJS.ProcessEnv = process.env,
): SecurityPostureExpectations {
  const enabled = truthy(env.NEMOCLAW_E2E_SECURITY_POSTURE);
  return {
    droppedBoundingCapabilities: enabled && truthy(env.NEMOCLAW_E2E_EXPECT_DROPPED_BOUNDS),
    enabled,
    noNewPrivileges: enabled && truthy(env.NEMOCLAW_E2E_EXPECT_NO_NEW_PRIVS),
    nonRootEntrypoint: enabled && truthy(env.NEMOCLAW_E2E_EXPECT_NON_ROOT_ENTRYPOINT),
  };
}

export function securityPostureModeEnv(): NodeJS.ProcessEnv {
  const expectations = securityPostureExpectations();
  if (!expectations.enabled) return {};
  return {
    NEMOCLAW_E2E_EXPECT_DROPPED_BOUNDS: expectations.droppedBoundingCapabilities ? "1" : "0",
    NEMOCLAW_E2E_EXPECT_NON_ROOT_ENTRYPOINT: expectations.nonRootEntrypoint ? "1" : "0",
    NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
    NEMOCLAW_E2E_EXPECT_NO_NEW_PRIVS: expectations.noNewPrivileges ? "1" : "0",
    NEMOCLAW_E2E_SECURITY_POSTURE: "1",
  };
}

export async function assertSecurityPosture(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  agent: SecurityPostureAgent,
): Promise<SecurityPostureSummary> {
  const expectations = securityPostureExpectations();
  const hostUser = await host.command(
    "sh",
    ["-lc", 'uid="$(id -u)"; gid="$(id -g)"; echo "uid=$uid gid=$gid"; test "$uid" -ne 0'],
    {
      artifactName: "security-posture-host-user",
      env: probeEnv(),
      timeoutMs: 15_000,
    },
  );
  requireSuccess("non-root host user", hostUser);

  const entrypoint = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      'grep -E "^(Uid|Gid|CapBnd|CapEff|NoNewPrivs):" /proc/1/status; ' +
        "test -n \"$(awk '/^Uid:/ { print $2; exit }' /proc/1/status)\"; " +
        "test -n \"$(awk '/^CapBnd:/ { print $2; exit }' /proc/1/status)\"",
    ),
    {
      artifactName: "security-posture-entrypoint-status",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("entrypoint security status", entrypoint);
  const uid = statusField(entrypoint.stdout, "Uid");
  const capBnd = statusField(entrypoint.stdout, "CapBnd");
  const capEff = statusField(entrypoint.stdout, "CapEff");
  const noNewPrivs = statusField(entrypoint.stdout, "NoNewPrivs");
  if (!uid || !capBnd) throw new Error(`entrypoint status is incomplete:\n${entrypoint.stdout}`);
  const dangerousBoundingCapabilities = dangerousCapabilities(capBnd);
  const dangerousEffectiveCapabilities = dangerousCapabilities(capEff);
  if (expectations.nonRootEntrypoint && uid === "0") {
    throw new Error(`entrypoint PID 1 expected a non-root uid, got ${uid}`);
  }
  if (expectations.droppedBoundingCapabilities && dangerousBoundingCapabilities.length > 0) {
    throw new Error(
      `entrypoint PID 1 retained bounding capabilities: ${dangerousBoundingCapabilities.join(", ")}`,
    );
  }
  if (expectations.noNewPrivileges && noNewPrivs !== "1") {
    throw new Error(`entrypoint PID 1 expected NoNewPrivs=1, got ${noNewPrivs ?? "<missing>"}`);
  }

  const rcFiles = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
bad=0
for f in /sandbox/.bashrc /sandbox/.profile; do
  test -f "$f" || { echo "MISSING $f"; bad=1; continue; }
  test ! -L "$f" || { echo "SYMLINK $f"; bad=1; }
  set -- $(stat -c "%a %U:%G" "$f")
  echo "META $f $1 $2"
  test "$1" = 444 || { echo "BAD_MODE $f $1"; bad=1; }
  test "$2" = root:root || { echo "BAD_OWNER $f $2"; bad=1; }
  grep -Eq "nemoclaw-configure-guard|^(openclaw|hermes)\(\)" "$f" && {
    echo "INLINE_GUARD $f"
    bad=1
  }
done
exit "$bad"
`),
    {
      artifactName: "security-posture-rc-files",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("locked sandbox rc files", rcFiles);

  const functionName = agent === "hermes" ? "hermes" : "openclaw";
  const guardArg = agent === "hermes" ? "setup" : "configure";
  // Security-posture mode is fail-closed on the non-root host invariant. The
  // runtime proxy file may therefore be owned by that current sandbox user.
  const allowNonRootOwner = "1";
  const proxyEnv = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
f=/tmp/nemoclaw-proxy-env.sh
bad=0
test -f "$f" || { echo MISSING_PROXY_ENV; exit 1; }
test ! -L "$f" || { echo SYMLINK_PROXY_ENV; bad=1; }
set -- $(stat -c "%a %U:%G" "$f")
echo "META $f $1 $2"
test "$1" = 444 || { echo "BAD_PROXY_ENV_MODE $1"; bad=1; }
current_owner="$(id -un):$(id -gn)"
if test "$2" != root:root; then
  test "${allowNonRootOwner}" = 1 && test "$2" = "$current_owner" || {
    echo "BAD_PROXY_ENV_OWNER $2"
    bad=1
  }
fi
grep -Fq '# nemoclaw-configure-guard begin' "$f" || { echo MISSING_GUARD_BEGIN; bad=1; }
grep -Fq '${functionName}() {' "$f" || { echo MISSING_AGENT_GUARD_FUNCTION; bad=1; }
grep -Fq '# nemoclaw-configure-guard end' "$f" || { echo MISSING_GUARD_END; bad=1; }
exit "$bad"
`),
    {
      artifactName: "security-posture-proxy-env",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("locked runtime proxy environment", proxyEnv);

  const configureGuard = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
. /tmp/nemoclaw-proxy-env.sh
if ${functionName} ${guardArg} >/tmp/nemoclaw-security-guard-probe.out 2>&1; then
  echo GUARD_DID_NOT_BLOCK
  cat /tmp/nemoclaw-security-guard-probe.out
  exit 1
fi
cat /tmp/nemoclaw-security-guard-probe.out
grep -q 'cannot modify config inside the sandbox' /tmp/nemoclaw-security-guard-probe.out
`),
    {
      artifactName: "security-posture-configure-guard",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess(`${functionName} ${guardArg} runtime guard`, configureGuard);

  const launchPattern =
    agent === "hermes" ? "hermes gateway launched" : "openclaw gateway launched";
  const startLog = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
log=/tmp/nemoclaw-start.log
test -f "$log" || { echo MISSING_START_LOG; exit 1; }
grep -qi '${launchPattern}' "$log" || { echo MISSING_GATEWAY_LAUNCH_MARKER; exit 1; }
if grep -E 'mktemp:.*(/sandbox/\.\.(bashrc|profile)\.tmp|/sandbox/\.nemoclaw.*tmp)|Permission denied.*(/sandbox/\.bashrc|/sandbox/\.profile)' "$log"; then
  echo START_LOG_HAS_RC_WRITE_FAILURE
  exit 1
fi
tail -n 20 "$log"
`),
    {
      artifactName: "security-posture-start-log",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("sandbox startup log security posture", startLog);

  return {
    configureGuard: true,
    entrypoint: {
      capBnd,
      capEff,
      dangerousBoundingCapabilities,
      dangerousEffectiveCapabilities,
      noNewPrivs,
      uid,
    },
    hostNonRoot: true,
    rcFilesLocked: true,
    runtimeProxyEnvLocked: true,
    startupLogClean: true,
  };
}
