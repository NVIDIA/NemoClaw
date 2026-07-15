// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SUPERVISOR_TLS_ENV_NAMES = [
  "OPENSHELL_TLS_CA",
  "OPENSHELL_TLS_CERT",
  "OPENSHELL_TLS_KEY",
] as const;
const ENTRYPOINT_ARGV = ["nemoclaw-dcode-entrypoint", "-f", "/dev/null"] as const;
const CONNECT_CHILD_OK = "NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_OK";

type ExactMainChildProofReport = {
  capBnd: string;
  surface: "entrypoint" | "exec";
  supervisorTlsEnvNames: string[];
};

export const ENTRYPOINT_CHILD_PROBE = String.raw`import json
from pathlib import Path

expected_argv = ${JSON.stringify(ENTRYPOINT_ARGV)}
tls_names = {${SUPERVISOR_TLS_ENV_NAMES.map((name) => JSON.stringify(name)).join(", ")}}
matches = []
for proc in Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    try:
        argv = [item.decode("utf-8", "strict") for item in (proc / "cmdline").read_bytes().split(b"\0") if item]
    except (OSError, UnicodeDecodeError):
        continue
    if argv == expected_argv:
        matches.append(proc)
if len(matches) != 1:
    raise SystemExit(f"expected exactly one Deep Agents entrypoint, found {len(matches)}")
proc = matches[0]
status = {}
for line in (proc / "status").read_text(encoding="utf-8").splitlines():
    name, separator, value = line.partition(":")
    if separator:
        status[name] = value.strip().split()[0]
cap_bnd = status.get("CapBnd", "")
if not cap_bnd or set(cap_bnd) != {"0"}:
    raise SystemExit(f"entrypoint retained capability bounding set {cap_bnd or '<missing>'}")
environment = {
    item.split(b"=", 1)[0].decode("utf-8", "strict")
    for item in (proc / "environ").read_bytes().split(b"\0")
    if b"=" in item
}
leaked = sorted(environment.intersection(tls_names))
if leaked:
    raise SystemExit(f"entrypoint inherited supervisor TLS identity names: {','.join(leaked)}")
print(json.dumps({
    "surface": "entrypoint",
    "capBnd": cap_bnd,
    "supervisorTlsEnvNames": leaked,
}, sort_keys=True))`;

export const EXEC_CHILD_PROBE = String.raw`import json
import os
from pathlib import Path

tls_names = {${SUPERVISOR_TLS_ENV_NAMES.map((name) => JSON.stringify(name)).join(", ")}}
status = {}
for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
    name, separator, value = line.partition(":")
    if separator:
        status[name] = value.strip().split()[0]
cap_bnd = status.get("CapBnd", "")
if not cap_bnd or set(cap_bnd) != {"0"}:
    raise SystemExit(f"exec child retained capability bounding set {cap_bnd or '<missing>'}")
leaked = sorted(set(os.environ).intersection(tls_names))
if leaked:
    raise SystemExit(f"exec child inherited supervisor TLS identity names: {','.join(leaked)}")
print(json.dumps({
    "surface": "exec",
    "capBnd": cap_bnd,
    "supervisorTlsEnvNames": leaked,
}, sort_keys=True))`;

export const CONNECT_CHILD_PROBE = String.raw`cap_bnd="$(awk '/^CapBnd:/ { print $2; exit }' "/proc/$$/status")"
case "$cap_bnd" in
  ""|*[!0]*)
    test -n "$cap_bnd" || cap_bnd=missing
    printf '%s\n' "NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_FAIL CapBnd=$cap_bnd" >&2
    exit 91
    ;;
esac
for name in ${SUPERVISOR_TLS_ENV_NAMES.join(" ")}; do
  if printenv "$name" >/dev/null 2>&1; then
    printf '%s\n' "NEMOCLAW_EXACT_MAIN_CONNECT_CHILD_FAIL inherited=$name" >&2
    exit 92
  fi
done
printf '%s\n' "${CONNECT_CHILD_OK} CapBnd=$cap_bnd"
exit 0`;

function exactMainDockerContainerId(output: string, sandboxName: string): string {
  const rows = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one running Docker container for ${sandboxName}, found ${rows.length}`,
    );
  }
  const [id, name, ...unexpected] = rows[0].split("\t");
  const expectedName = `openshell-${sandboxName}`;
  if (
    !id ||
    !/^[0-9a-f]{12,64}$/u.test(id) ||
    !name ||
    unexpected.length > 0 ||
    (name !== expectedName && !name.startsWith(`${expectedName}-`))
  ) {
    throw new Error(`unexpected OpenShell Docker container identity for ${sandboxName}`);
  }
  return id;
}

function assertChildProofReport(
  result: ShellProbeResult,
  surface: ExactMainChildProofReport["surface"],
): void {
  expectExitZero(result, `exact-main ${surface} child security boundary`);
  let report: ExactMainChildProofReport;
  try {
    report = JSON.parse(result.stdout.trim()) as ExactMainChildProofReport;
  } catch (error) {
    throw new Error(`exact-main ${surface} child emitted an invalid proof report`, {
      cause: error,
    });
  }
  if (report.surface !== surface) {
    throw new Error(`exact-main child proof reported ${report.surface} instead of ${surface}`);
  }
  if (!/^[0]+$/u.test(report.capBnd)) {
    throw new Error(`exact-main ${surface} child expected full CapBnd=0, got ${report.capBnd}`);
  }
  if (!Array.isArray(report.supervisorTlsEnvNames) || report.supervisorTlsEnvNames.length !== 0) {
    throw new Error(
      `exact-main ${surface} child exposed supervisor TLS identity: ${JSON.stringify(report.supervisorTlsEnvNames)}`,
    );
  }
}

function assertConnectChildProof(result: ShellProbeResult): void {
  expectExitZero(result, "exact-main connect child security boundary");
  const proofLines = resultText(result)
    .replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${CONNECT_CHILD_OK} CapBnd=`));
  if (proofLines.length !== 1) {
    throw new Error(`exact-main connect child emitted ${proofLines.length} proof markers`);
  }
  const capBnd = proofLines[0].slice(`${CONNECT_CHILD_OK} CapBnd=`.length);
  if (!/^[0]+$/u.test(capBnd)) {
    throw new Error(`exact-main connect child expected full CapBnd=0, got ${capBnd}`);
  }
}

export async function assertExactMainChildProcessContracts(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  const containers = await host.command(
    "docker",
    [
      "ps",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    {
      artifactName: "exact-main-entrypoint-container-identity",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(containers, "exact-main entrypoint container discovery");
  const containerId = exactMainDockerContainerId(containers.stdout, sandboxName);

  // OpenShell makes workload children non-dumpable. Inspect the long-running
  // entrypoint from the Docker container's root control plane so this proves
  // that process itself rather than inferring its state from a fresh exec.
  const entrypoint = await host.command(
    "docker",
    ["exec", "--user", "0", containerId, "python3", "-c", ENTRYPOINT_CHILD_PROBE],
    {
      artifactName: "exact-main-entrypoint-child-security-boundary",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertChildProofReport(entrypoint, "entrypoint");

  const execChild = await host.nemoclaw(
    [sandboxName, "exec", "--", "python3", "-c", EXEC_CHILD_PROBE],
    {
      artifactName: "exact-main-exec-child-security-boundary",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertChildProofReport(execChild, "exec");

  // OpenShell main exposes connect only as a forced-TTY shell. Feed a bounded
  // script on stdin and make the remote shell return the assertion status;
  // an exact output marker distinguishes executed output from TTY input echo.
  const connectChild = await host.command(
    "bash",
    [
      "-lc",
      'printf \'%s\\n\' "$1" | "$2" sandbox connect "$3"',
      "exact-main-connect-child",
      CONNECT_CHILD_PROBE,
      host.openshellCommandPath,
      sandboxName,
    ],
    {
      artifactName: "exact-main-connect-child-security-boundary",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 90_000,
    },
  );
  assertConnectChildProof(connectChild);
}

function expectExitNonZero(result: ShellProbeResult, label: string, pattern: RegExp): void {
  expect(
    result.exitCode,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toBe(0);
  expect(resultText(result)).toMatch(pattern);
}

export async function assertExactMainOpenShellContracts(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  // The stable release lane sets this gate and requires this proof before
  // accepting the pinned OpenShell release. The historical environment name is
  // retained so the proof helpers and their artifacts stay backward compatible.
  if (process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF !== "1") return;

  await assertExactMainChildProcessContracts(host, sandboxName);

  const payload = "lf-one\ncrlf-two\r\nsingle-' double-\"\rbare-cr";
  const encoder = [
    "import base64, sys",
    'print(base64.b64encode(sys.argv[1].encode("utf-8")).decode("ascii"))',
  ].join("\n");
  const encoded = await host.nemoclaw(
    [sandboxName, "exec", "--", "python3", "-c", encoder, payload],
    {
      artifactName: "exact-main-multiline-argv-bytes",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(encoded, "exact-main multiline argv byte preservation");
  expect(encoded.stdout.trim()).toBe(Buffer.from(payload, "utf8").toString("base64"));

  const expectedHeredoc = "first line\nquote ' and double \"\nlast line\n";
  const heredoc = [
    "cat <<'NEMOCLAW_EXACT_MAIN_EOF'",
    "first line",
    "quote ' and double \"",
    "last line",
    "NEMOCLAW_EXACT_MAIN_EOF",
  ].join("\n");
  const heredocResult = await host.nemoclaw([sandboxName, "exec", "--", "bash", "-lc", heredoc], {
    artifactName: "exact-main-multiline-heredoc",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(heredocResult, "exact-main literal heredoc execution");
  expect(heredocResult.stdout).toBe(expectedHeredoc);

  const invalidWorkdir = await host.command(
    host.openshellCommandPath,
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--workdir",
      "/tmp/invalid\r\nworkdir",
      "--",
      "true",
    ],
    {
      artifactName: "exact-main-multiline-workdir-rejected",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitNonZero(
    invalidWorkdir,
    "exact-main multiline workdir rejection",
    /newline|carriage return/i,
  );

  const invalidEnvironment = await host.command(
    host.openshellCommandPath,
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--env",
      "NEMOCLAW_MULTILINE_VALUE=line-one\nline-two",
      "--",
      "true",
    ],
    {
      artifactName: "exact-main-multiline-env-rejected",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitNonZero(
    invalidEnvironment,
    "exact-main multiline environment rejection",
    /newline|carriage return/i,
  );
}
