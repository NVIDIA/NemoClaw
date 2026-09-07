// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Keeps the same real boundaries as the former shell test — repo CLI, Docker,
 * OpenShell sandbox commands, in-sandbox process/PTY probes, logs streaming,
 * and gateway recovery — without introducing another target framework.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  assertExitZero as expectExitZero,
  outputContainsSandbox,
  resultText,
  shellQuote,
} from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  type HostedInferenceConfig,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { expectSandboxProviderAttachment } from "../fixtures/gateway-providers.ts";
import {
  RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
  RESOURCE_LIMIT_CONNECT_END_MARKER,
  resourceLimitOutputFilterScript,
} from "../fixtures/resource-limit-diagnostics.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import { ubuntuRepoManagedRuntime } from "../registry/matrix.ts";

const ENVIRONMENT = ubuntuRepoManagedRuntime("cloud-openclaw");
const SANDBOX_A = "e2e-sbx-a";
const SANDBOX_B = "e2e-sbx-b";
const CREDENTIAL_PROVIDER = "e2e-sandbox-tavily";
const CREDENTIAL_ENV_NAME = "TAVILY_API_KEY";
const CREDENTIAL_VALUE = "e2e-sandbox-operations-provider-secret";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const GATEWAY_CONTAINER = "openshell-cluster-nemoclaw";
const GATEWAY_PORT = process.env.NEMOCLAW_GATEWAY_PORT ?? "8080";
const LEGACY_FORWARD_SANDBOX = "e2e-legacy-forward";
const LEGACY_DASHBOARD_PORT = Number(process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789");
const LEGACY_UNREGISTERED_PORT = 19_789;

function numericProbe(text: string, key: string): number {
  const prefix = `${key}=`;
  const values = text
    .split(/\r?\n/u)
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => candidate.slice(prefix.length));
  expect(values, `Expected exactly one ${key} in sanitized connect summary`).toHaveLength(1);
  expect(values[0], `Expected a numeric ${key} in sanitized connect summary`).toMatch(/^\d+$/u);
  return Number(values[0] ?? "NaN");
}

function connectRlimitProbeScript(cliPath: string): string {
  const cli = JSON.stringify(cliPath);
  const outputFilter = `${shellQuote(process.execPath)} -e ${shellQuote(resourceLimitOutputFilterScript())}`;
  const shellProbe = [
    "set +e",
    'nproc_soft="$(builtin ulimit -Su)"',
    'nproc_hard="$(builtin ulimit -Hu)"',
    'nofile_soft="$(builtin ulimit -Sn)"',
    'nofile_hard="$(builtin ulimit -Hn)"',
    "(builtin ulimit -Su 5000) >/dev/null 2>&1",
    'raise_nproc="$?"',
    "(builtin ulimit -Sn 1048576) >/dev/null 2>&1",
    'raise_nofile="$?"',
    "set -e",
    'printf "nproc_soft=%s\\nnproc_hard=%s\\nnofile_soft=%s\\nnofile_hard=%s\\nraise_nproc=%s\\nraise_nofile=%s\\n" "$nproc_soft" "$nproc_hard" "$nofile_soft" "$nofile_hard" "$raise_nproc" "$raise_nofile"',
  ].join("; ");
  return [
    "set -euo pipefail",
    `cat <<'NEMOCLAW_CONNECT_RLIMITS' | ${cli} connect 2>&1 | ${outputFilter}`,
    "set -euo pipefail",
    'printf "__NEMOCLAW_RLIMIT_CONNECT_%s__\\n" BEGIN',
    `bash -lc '${shellProbe}' | sed 's/^/login_/'`,
    `bash -ic '${shellProbe}' 2>&1 | sed 's/^/interactive_/'`,
    'printf "__NEMOCLAW_RLIMIT_CONNECT_%s__\\n" END',
    "exit",
    "NEMOCLAW_CONNECT_RLIMITS",
  ].join("\n");
}

async function assertConnectResourceLimits(host: HostCliClient): Promise<string> {
  const connect = await host.command("bash", ["-lc", connectRlimitProbeScript(host.commandPath)], {
    artifactName: "tc-sbx-13-connect-rlimits",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 3 * 60_000,
  });
  const summary = resultText(connect);
  const exit = connect.signal
    ? `signal=${connect.signal}`
    : `exit=${connect.exitCode ?? "unknown"}`;
  expect(
    connect.exitCode,
    `nemoclaw connect resource-limit probe failed: ${exit}, timedOut=${String(connect.timedOut)}`,
  ).toBe(0);
  expect(summary).toContain(RESOURCE_LIMIT_CONNECT_BEGIN_MARKER);
  expect(summary).toContain(RESOURCE_LIMIT_CONNECT_END_MARKER);
  expect(
    numericProbe(summary, "resource_limit_diagnostic"),
    "connect shell startup must not print resource-limit security diagnostics",
  ).toBe(0);
  expect(
    numericProbe(summary, "resource_limit_protocol_error"),
    "connect resource-limit summary must contain exactly one complete probe frame",
  ).toBe(0);
  for (const shell of ["login", "interactive"]) {
    expect(numericProbe(summary, `${shell}_nproc_soft`)).toBeLessThanOrEqual(4096);
    expect(numericProbe(summary, `${shell}_nproc_hard`)).toBeLessThanOrEqual(4096);
    expect(numericProbe(summary, `${shell}_nofile_soft`)).toBeLessThanOrEqual(65536);
    expect(numericProbe(summary, `${shell}_nofile_hard`)).toBeLessThanOrEqual(65536);
    expect(numericProbe(summary, `${shell}_raise_nproc`)).not.toBe(0);
    expect(numericProbe(summary, `${shell}_raise_nofile`)).not.toBe(0);
  }
  return summary;
}

async function onboardSandbox(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  sandboxName: string,
  artifactName: string,
  hosted: HostedInferenceConfig,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ShellProbeResult> {
  cleanup.trackSandbox(host, sandboxName);
  const result = await host.nemoclaw(
    ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
    {
      artifactName,
      env: {
        ...buildAvailabilityProbeEnv(),
        // The shared hosted configuration intentionally wins over availability
        // defaults; extraEnv remains the per-sandbox override boundary.
        ...hosted.env,
        ...extraEnv,
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_SANDBOX_NAME: sandboxName,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      },
      redactionValues: [hosted.apiKey],
      timeoutMs: execTimeout(20 * 60_000),
    },
  );
  expectExitZero(result, `nemoclaw onboard ${sandboxName}`);
  return result;
}

async function resetCredentialProvider(
  host: HostCliClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  const reset = await host.nemoclaw(["credentials", "reset", CREDENTIAL_PROVIDER, "--yes"], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    redactionValues: [CREDENTIAL_VALUE],
    timeoutMs: 3 * 60_000,
  });
  expectExitZero(reset, `nemoclaw credentials reset ${CREDENTIAL_PROVIDER} --yes`);
  expect(resultText(reset)).not.toContain(CREDENTIAL_VALUE);
  return reset;
}

async function expectListed(host: HostCliClient, sandboxName: string, artifactName: string) {
  const list = await host.nemoclaw(["list"], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list");
  expect(outputContainsSandbox(list, sandboxName), resultText(list)).toBe(true);
  return list;
}

async function execInSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  script: string,
  artifactName: string,
  timeoutMs = 60_000,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs,
  });
}

function credentialBoundaryProbeScript(): string {
  const fixtureDigest = createHash("sha256").update(CREDENTIAL_VALUE, "utf8").digest("hex");
  return `python3 - ${shellQuote(fixtureDigest)} ${CREDENTIAL_VALUE.length} <<'PY'
from pathlib import Path
import hashlib
import os
import sys

secret_digest = bytes.fromhex(sys.argv[1])
secret_length = int(sys.argv[2])

def contains_secret(path):
    try:
        content = Path(path).read_bytes()
    except OSError:
        return False
    if len(content) < secret_length:
        return False
    view = memoryview(content)
    return any(
        hashlib.sha256(view[offset:offset + secret_length]).digest() == secret_digest
        for offset in range(len(content) - secret_length + 1)
    )

def contains_secret_bytes(content):
    if len(content) < secret_length:
        return False
    view = memoryview(content)
    return any(
        hashlib.sha256(view[offset:offset + secret_length]).digest() == secret_digest
        for offset in range(len(content) - secret_length + 1)
    )

environment = b"\\0".join(
    f"{key}={value}".encode("utf-8", errors="surrogateescape")
    for key, value in os.environ.items()
)
if contains_secret_bytes(environment):
    raise SystemExit(98)

managed_config_files = 0
for root_text in ("/sandbox/.openclaw", "/etc/nemoclaw", "/tmp"):
    root = Path(root_text)
    if not root.exists():
        continue
    for path in root.rglob("*"):
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
                continue
        except OSError:
            continue
        if root_text != "/tmp":
            managed_config_files += 1
        if contains_secret(path):
            raise SystemExit(98)

agent_environment_inspected = False
for process in Path("/proc").iterdir():
    if not process.name.isdigit():
        continue
    try:
        command = (process / "cmdline").read_bytes()
    except OSError:
        continue
    if b"openclaw" not in command.lower():
        continue
    try:
        agent_environment = (process / "environ").read_bytes()
    except OSError:
        continue
    agent_environment_inspected = True
    if contains_secret_bytes(command) or contains_secret_bytes(agent_environment):
        raise SystemExit(98)

if managed_config_files == 0 or not agent_environment_inspected:
    raise SystemExit(97)
PY`;
}

async function assertCredentialRemainsOutsideSandbox(sandbox: SandboxClient): Promise<void> {
  const probe = await execInSandbox(
    sandbox,
    SANDBOX_A,
    credentialBoundaryProbeScript(),
    "tc-sbx-14-sandbox-credential-boundary",
    180_000,
  );
  expect(
    probe.exitCode,
    "credential fixture must remain absent from sandbox environment and managed runtime configuration",
  ).toBe(0);
}

async function assertAgentCanAnswer(
  host: HostCliClient,
  sandboxName: string,
  artifactName = "tc-sbx-02-nemoclaw-agent-json",
): Promise<void> {
  const sessionId = `e2e-sbx-02-${Date.now()}-${process.pid}`;
  const result = await host.nemoclaw(
    [
      sandboxName,
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      sessionId,
      "-m",
      "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    },
  );
  const reply = parseOpenClawAgentText(result.stdout);
  expectExitZero(result, `nemoclaw ${sandboxName} agent --json`);
  expect(containsAnswer(reply, "42"), resultText(result)).toBe(true);
}

async function assertForcedGatewayRestart(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const identityScript = [
    "set -eu",
    "read -r pid starttime extra </tmp/nemoclaw-gateway.pid",
    "case \"$pid\" in ''|*[!0-9]*) echo INVALID_GATEWAY_PID >&2; exit 1 ;; esac",
    "case \"$starttime\" in ''|*[!0-9]*) echo INVALID_GATEWAY_STARTTIME >&2; exit 1 ;; esac",
    '[ -z "$extra" ] || { echo INVALID_GATEWAY_PID_RECORD >&2; exit 1; }',
    'actual_start=$(python3 -c \'import sys; from pathlib import Path; text=Path(f"/proc/{sys.argv[1]}/stat").read_text(); tail=text.rsplit(")", 1)[1].split(); print(tail[19])\' "$pid")',
    '[ "$actual_start" = "$starttime" ] || { echo GATEWAY_PID_REUSED >&2; exit 1; }',
    "pid1_argv0=$(tr '\\0' '\\n' </proc/1/cmdline | sed -n '1p')",
    "pid1_cmdline=$(tr '\\0' ' ' </proc/1/cmdline)",
    'if [ "$pid1_argv0" = /opt/openshell/bin/openshell-sandbox ]; then expected_user=sandbox; topology=openshell-managed; else case "$pid1_cmdline" in *nemoclaw-start*) expected_user=gateway; topology=direct-root ;; *) echo "UNEXPECTED_PID1=$pid1_cmdline" >&2; exit 1 ;; esac; fi',
    'user=$(ps -p "$pid" -o user= | tr -d " ")',
    '[ "$user" = "$expected_user" ] || { echo "UNEXPECTED_GATEWAY_USER=$user EXPECTED=$expected_user TOPOLOGY=$topology" >&2; exit 1; }',
    'comm=$(ps -p "$pid" -o comm= | tr -d " ")',
    'case "$comm" in openclaw*) ;; *) echo "UNEXPECTED_GATEWAY_COMM=$comm" >&2; exit 1 ;; esac',
    'python3 -c \'from pathlib import Path; text=Path("/proc/1/stat").read_text(); tail=text.rsplit(")", 1)[1].split(); print("PID1_START=" + tail[19])\'',
    'printf "TOPOLOGY=%s\\n" "$topology"',
    'printf "GATEWAY=%s:%s:%s\\n" "$user" "$pid" "$starttime"',
  ].join("; ");
  const before = await execInSandbox(
    sandbox,
    sandboxName,
    identityScript,
    "tc-sbx-08b-gateway-identity-before-forced-restart",
  );
  expectExitZero(before, "OpenClaw gateway identity before forced restart");

  const restart = await host.nemoclaw([sandboxName, "gateway", "restart"], {
    artifactName: "tc-sbx-08b-openclaw-forced-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 180_000,
  });
  expectExitZero(restart, `nemoclaw ${sandboxName} gateway restart`);
  expect(resultText(restart)).toContain("Gateway restarted");
  expect(resultText(restart)).toContain("health passed");

  const after = await execInSandbox(
    sandbox,
    sandboxName,
    identityScript,
    "tc-sbx-08b-gateway-identity-after-forced-restart",
  );
  expectExitZero(after, "OpenClaw gateway identity after forced restart");

  const beforeGateway = before.stdout.match(/GATEWAY=(gateway|sandbox):([0-9]+:[0-9]+)/);
  const afterGateway = after.stdout.match(/GATEWAY=(gateway|sandbox):([0-9]+:[0-9]+)/);
  const beforeIdentity = beforeGateway?.[2];
  const afterIdentity = afterGateway?.[2];
  const beforePid1 = before.stdout.match(/PID1_START=([0-9]+)/)?.[1];
  const afterPid1 = after.stdout.match(/PID1_START=([0-9]+)/)?.[1];
  expect(beforeIdentity).toBeTruthy();
  expect(afterIdentity).toBeTruthy();
  expect(afterGateway?.[1]).toBe(beforeGateway?.[1]);
  expect(afterIdentity).not.toBe(beforeIdentity);
  expect(afterPid1).toBe(beforePid1);

  await assertAgentCanAnswer(host, sandboxName, "tc-sbx-08b-agent-json-after-forced-restart");
}

async function assertAgentJsonNonzeroExit(host: HostCliClient, sandboxName: string): Promise<void> {
  const invalidFlag = await host.nemoclaw(
    [sandboxName, "agent", "--json", "--nemoclaw-e2e-invalid-openclaw-agent-flag"],
    {
      artifactName: "tc-sbx-02b-agent-json-nonzero",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(invalidFlag.timedOut, resultText(invalidFlag)).toBe(false);
  expect(invalidFlag.exitCode, resultText(invalidFlag)).not.toBeNull();
  expect(invalidFlag.exitCode, resultText(invalidFlag)).not.toBe(0);

  // The v0.0.69 legacy job did not exercise piped stdin. That experimental
  // migration-only assertion was retired instead of expanding the parity lane.
  // Failed-tool provenance remains covered deterministically by
  // test/agents/openclaw/openclaw-agent-json.test.ts; a live prompt cannot require upstream
  // OpenClaw to emit failed tool-result metadata. Re-add live stdin coverage if
  // the frozen parity source gains that contract or transport validation is
  // explicitly added to this lane's scope.
}

async function assertStatusFields(host: HostCliClient, sandboxName: string): Promise<void> {
  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-03-status-fields",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expectExitZero(status, `nemoclaw ${sandboxName} status`);
  const text = resultText(status);
  for (const field of ["Sandbox", "Model", "Provider", "GPU"]) {
    expect(text, `missing status field ${field}:\n${text}`).toMatch(new RegExp(field, "i"));
  }
}

async function assertLogsStream(host: HostCliClient, sandboxName: string): Promise<void> {
  const logs = await host.nemoclaw([sandboxName, "logs"], {
    artifactName: "tc-sbx-04-logs",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 15_000,
  });
  expectExitZero(logs, `nemoclaw ${sandboxName} logs`);
  expect(resultText(logs).trim().length, "logs command produced no output").toBeGreaterThan(0);

  const follow = await host.nemoclaw([sandboxName, "logs", "--follow"], {
    artifactName: "tc-sbx-04-logs-follow",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 5_000,
    killGraceMs: 1_000,
  });
  expect(follow.timedOut, "logs --follow should keep streaming until timeout kills it").toBe(true);
}

async function assertTmuxPtyFlow(sandbox: SandboxClient, sandboxName: string): Promise<void> {
  const tmux = await execInSandbox(
    sandbox,
    sandboxName,
    "command -v tmux || echo TMUX_MISSING",
    "tc-sbx-09-tmux-present",
  );
  expect(resultText(tmux), "tmux is missing inside sandbox (#4513)").not.toContain("TMUX_MISSING");

  const pty = await execInSandbox(
    sandbox,
    sandboxName,
    "if command -v python3 >/dev/null 2>&1; then python3 -c 'import os; _,s=os.openpty(); print(os.ttyname(s))' && echo PTY_OK; else echo PY3_MISSING; fi",
    "tc-sbx-09-pty-allocation",
  );
  if (!resultText(pty).includes("PY3_MISSING")) {
    expect(resultText(pty), `PTY allocation failed (#4513):\n${resultText(pty)}`).toContain(
      "PTY_OK",
    );
  }

  const session = `nemoclaw-e2e-tmux-${process.pid}-${Date.now()}`;
  const flow = await execInSandbox(
    sandbox,
    sandboxName,
    `TMUX_TMPDIR=/tmp tmux new-session -d -s '${session}' 'sleep 30' && TMUX_TMPDIR=/tmp tmux list-sessions && TMUX_TMPDIR=/tmp tmux kill-session -t '${session}' && echo TMUX_FLOW_OK`,
    "tc-sbx-09-tmux-lifecycle",
  );
  if (!resultText(flow).includes("TMUX_FLOW_OK")) {
    await execInSandbox(
      sandbox,
      sandboxName,
      `TMUX_TMPDIR=/tmp tmux kill-session -t '${session}' 2>/dev/null || true`,
      "tc-sbx-09-tmux-cleanup",
    );
  }
  expect(resultText(flow), `tmux lifecycle failed:\n${resultText(flow)}`).toContain("TMUX_FLOW_OK");
}

async function assertRegistryRebuild(host: HostCliClient, sandboxName: string): Promise<void> {
  if (!fs.existsSync(REGISTRY_FILE)) {
    throw new Error(
      `registry rebuild contract requires ${REGISTRY_FILE} to exist after onboarding`,
    );
  }
  const backup = `${REGISTRY_FILE}.e2e-sbx-backup-${process.pid}`;
  fs.copyFileSync(REGISTRY_FILE, backup);
  try {
    fs.rmSync(REGISTRY_FILE, { force: true });
    await expectListed(host, sandboxName, "tc-sbx-07-registry-rebuild-list");
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.copyFileSync(backup, REGISTRY_FILE);
    throw error;
  } finally {
    fs.rmSync(backup, { force: true });
  }
}

async function assertProcessRecovery(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const kill = await execInSandbox(
    sandbox,
    sandboxName,
    [
      "set -eu",
      "read -r pid starttime extra </tmp/nemoclaw-gateway.pid",
      "case \"$pid\" in ''|*[!0-9]*) echo INVALID_GATEWAY_PID >&2; exit 1 ;; esac",
      "case \"$starttime\" in ''|*[!0-9]*) echo INVALID_GATEWAY_STARTTIME >&2; exit 1 ;; esac",
      '[ -z "$extra" ] || { echo INVALID_GATEWAY_PID_RECORD >&2; exit 1; }',
      'actual_start=$(python3 -c \'import sys; from pathlib import Path; text=Path(f"/proc/{sys.argv[1]}/stat").read_text(); tail=text.rsplit(")", 1)[1].split(); print(tail[19])\' "$pid")',
      '[ "$actual_start" = "$starttime" ] || { echo GATEWAY_PID_REUSED >&2; exit 1; }',
      "pid1_argv0=$(tr '\\0' '\\n' </proc/1/cmdline | sed -n '1p')",
      "pid1_cmdline=$(tr '\\0' ' ' </proc/1/cmdline)",
      'if [ "$pid1_argv0" = /opt/openshell/bin/openshell-sandbox ]; then expected_user=sandbox; else case "$pid1_cmdline" in *nemoclaw-start*) expected_user=gateway ;; *) echo "UNEXPECTED_PID1=$pid1_cmdline" >&2; exit 1 ;; esac; fi',
      'user=$(ps -p "$pid" -o user= | tr -d " ")',
      '[ "$user" = "$expected_user" ] || { echo "UNEXPECTED_GATEWAY_USER=$user EXPECTED=$expected_user" >&2; exit 1; }',
      'comm=$(ps -p "$pid" -o comm= | tr -d " ")',
      'case "$comm" in openclaw*) ;; *) echo "UNEXPECTED_GATEWAY_COMM=$comm" >&2; exit 1 ;; esac',
      'kill -9 "$pid"',
      'printf "KILLED_GATEWAY=%s:%s:%s\\n" "$user" "$pid" "$starttime"',
    ].join("; "),
    "tc-sbx-08-kill-openclaw-gateway",
  );
  expectExitZero(kill, "kill exact OpenClaw gateway identity");
  expect(kill.stdout, resultText(kill)).toMatch(/KILLED_GATEWAY=(?:gateway|sandbox):[0-9]+:[0-9]+/);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-08-status-recovers-process",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expectExitZero(status, `nemoclaw ${sandboxName} status after process kill`);
  expect(resultText(status)).toMatch(/recover|running|healthy|OpenClaw/i);

  const ssh = await execInSandbox(
    sandbox,
    sandboxName,
    "echo process-recovery-ok",
    "tc-sbx-08-ssh-after-recovery",
  );
  expect(resultText(ssh), "sandbox exec failed after process recovery").toContain(
    "process-recovery-ok",
  );
}

async function assertMetadataForBothSandboxes(
  host: HostCliClient,
  sandboxA: string,
  sandboxB: string,
): Promise<void> {
  const list = await host.nemoclaw(["list"], {
    artifactName: "tc-sbx-10-list-two-sandboxes",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list after second sandbox onboard");
  expect(outputContainsSandbox(list, sandboxA), resultText(list)).toBe(true);
  expect(outputContainsSandbox(list, sandboxB), resultText(list)).toBe(true);
  for (const sandboxName of [sandboxA, sandboxB]) {
    const entryPattern = new RegExp(
      `${sandboxName}[\\s\\S]*?agent:.*?model:\\s*(?!unknown\\b)\\S+.*?provider:\\s*(?!unknown\\b)\\S+`,
      "i",
    );
    expect(resultText(list), `missing model/provider metadata for ${sandboxName}`).toMatch(
      entryPattern,
    );
  }
}

async function assertNetworkIsolation(
  sandbox: SandboxClient,
  source: string,
  target: string,
  artifactName: string,
): Promise<void> {
  const probe = await execInSandbox(
    sandbox,
    source,
    `node -e "const http = require('http'); const req = http.get('http://${target}:18789/', (res) => { console.log('STATUS_' + res.statusCode); res.resume(); }); req.on('error', (e) => console.log('ERROR: ' + e.message)); req.setTimeout(5000, () => { req.destroy(); console.log('TIMEOUT'); });"`,
    artifactName,
    15_000,
  );
  const text = resultText(probe);
  expect(text.trim().length, "network isolation probe produced no output").toBeGreaterThan(0);
  expect(text, `sandbox ${source} unexpectedly reached ${target}:\n${text}`).toMatch(
    /STATUS_403|ERROR|TIMEOUT/i,
  );
  expect(text, `sandbox ${source} reached ${target}:\n${text}`).not.toMatch(/STATUS_2[0-9][0-9]/);
}

async function assertDestroyRemovesSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  options: { cleanupGateway?: boolean } = {},
): Promise<void> {
  const destroyArgs = [
    sandboxName,
    "destroy",
    "--yes",
    ...(options.cleanupGateway ? ["--cleanup-gateway"] : []),
  ];
  const destroy = await host.nemoclaw(destroyArgs, {
    artifactName: `tc-sbx-05-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 15 * 60_000,
  });
  expectExitZero(destroy, `nemoclaw ${destroyArgs.join(" ")}`);

  const list = await host.nemoclaw(["list"], {
    artifactName: `tc-sbx-05-nemoclaw-list-after-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expect(outputContainsSandbox(list, sandboxName), resultText(list)).toBe(false);

  const openshellList = await sandbox.list({
    artifactName: `tc-sbx-05-openshell-list-after-destroy-${sandboxName}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expect(outputContainsSandbox(openshellList, sandboxName), resultText(openshellList)).toBe(false);
}

async function expectHostPortFree(
  host: HostCliClient,
  port: string,
  artifactName: string,
  timeoutMs = 90_000,
): Promise<void> {
  const probe = await host.command(
    "node",
    [
      "-e",
      'const net=require("node:net"); const port=Number(process.argv[1]); const deadline=Date.now()+Number(process.argv[2]); const attempt=()=>{ const server=net.createServer(); server.once("error", error => { if (Date.now() >= deadline) { console.error(error.code || "bind failed"); process.exit(1); } setTimeout(attempt, 2000); }); server.listen(port, "127.0.0.1", () => server.close(error => { if (error) { console.error(error.message); process.exit(1); } console.log("available"); })); }; attempt();',
      port,
      String(timeoutMs),
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: timeoutMs + 30_000,
    },
  );
  expectExitZero(probe, `gateway port ${port} remained occupied after final destroy`);
}

type GatewayRecoveryOutcome =
  | "recovered-before-status"
  | "recovered-by-status"
  | "skipped-gateway-absent";

async function assertGatewayRecovery(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  sandboxName: string,
): Promise<GatewayRecoveryOutcome> {
  const running = await runtimeProvider.command(
    ["container", "ps", "--filter", `name=^${GATEWAY_CONTAINER}$`, "--format", "{{.Names}}"],
    {
      artifactName: "tc-sbx-06-gateway-runtime-resource-running",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  if (!running.stdout.split(/\r?\n/u).some((name) => name.trim() === GATEWAY_CONTAINER)) {
    return "skipped-gateway-absent";
  }

  const kill = await runtimeProvider.command(["container", "kill", GATEWAY_CONTAINER], {
    artifactName: "tc-sbx-06-runtime-kill-gateway",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expectExitZero(kill, "kill shared NemoClaw gateway container");
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const afterKill = await runtimeProvider.command(
    ["container", "inspect", "--format", "{{.State.Running}}", GATEWAY_CONTAINER],
    {
      artifactName: "tc-sbx-06-gateway-container-after-kill",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  const recoveryOutcome =
    afterKill.stdout.trim() === "true" ? "recovered-before-status" : "recovered-by-status";

  const status = await host.nemoclaw([sandboxName, "status"], {
    artifactName: "tc-sbx-06-status-recovers-gateway",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 10 * 60_000,
  });
  const afterStatus = await runtimeProvider.command(
    ["container", "inspect", "--format", "{{.State.Running}}", GATEWAY_CONTAINER],
    {
      artifactName: "tc-sbx-06-gateway-container-after-status",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15_000,
    },
  );
  expectExitZero(status, `nemoclaw ${sandboxName} status after gateway kill`);
  expect(afterStatus.stdout.trim(), resultText(afterStatus)).toBe("true");
  return recoveryOutcome;
}

function legacyForwardEnvironment(hosted: HostedInferenceConfig): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...hosted.env,
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_DASHBOARD_PORT: String(LEGACY_DASHBOARD_PORT),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: LEGACY_FORWARD_SANDBOX,
    OPENSHELL_GATEWAY: "nemoclaw",
  };
}

async function runLegacyForwardMigration(
  host: HostCliClient,
  runtimeProvider: RuntimeProviderPrerequisite,
  hosted: HostedInferenceConfig,
): Promise<void> {
  const migrationEnv = legacyForwardEnvironment(hosted);
  const stopAndRelease = await host.command(
    "bash",
    [
      "-lc",
      String.raw`set -euo pipefail
nemoclaw="$1"
sandbox_name="$2"
dashboard_port="$3"
"$nemoclaw" "$sandbox_name" stop
python3 - "$dashboard_port" <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(120):
    listener = socket.socket()
    try:
        listener.bind(("127.0.0.1", port))
    except OSError:
        listener.close()
        time.sleep(0.5)
        continue
    listener.close()
    raise SystemExit(0)
raise SystemExit(1)
PY
printf 'DIRECT_FORWARD_RELEASED=%s\n' "$dashboard_port"`,
      "legacy-forward-stop-and-release",
      host.commandPath,
      LEGACY_FORWARD_SANDBOX,
      String(LEGACY_DASHBOARD_PORT),
    ],
    {
      artifactName: "legacy-forward-stop-direct-service",
      env: migrationEnv,
      redactionValues: [hosted.apiKey],
      timeoutMs: 5 * 60_000,
    },
  );
  expect(stopAndRelease.exitCode, resultText(stopAndRelease)).toBe(0);

  const resourceHandle = await runtimeProvider.resolveSandboxResourceHandle(
    LEGACY_FORWARD_SANDBOX,
    {
      artifactName: "legacy-forward-resolve-stopped-sandbox",
      timeoutMs: 60_000,
    },
  );
  const startWorkload = await runtimeProvider.command(["container", "start", resourceHandle], {
    artifactName: "legacy-forward-start-sandbox-workload-only",
    timeoutMs: 120_000,
  });
  expect(startWorkload.exitCode, resultText(startWorkload)).toBe(0);

  const migrate = await host.command(
    "bash",
    [
      "-lc",
      String.raw`set -euo pipefail
nemoclaw="$1"
openshell="$2"
sandbox_name="$3"
dashboard_port="$4"
unregistered_port="$5"
gateway="$6"

wait_for_ready() {
  attempts=0
  until "$openshell" sandbox get "$sandbox_name" --gateway "$gateway" 2>&1 | grep -Eiq '\bReady\b'; do
    attempts=$((attempts + 1))
    (( attempts < 60 )) || return 1
    sleep 2
  done
}

wait_for_reachable() {
  python3 - "$1" <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(120):
    try:
        connection = socket.create_connection(("127.0.0.1", port), timeout=1)
    except OSError:
        time.sleep(0.5)
        continue
    connection.close()
    raise SystemExit(0)
raise SystemExit(1)
PY
}

wait_for_free() {
  python3 - "$1" <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(120):
    listener = socket.socket()
    try:
        listener.bind(("127.0.0.1", port))
    except OSError:
        listener.close()
        time.sleep(0.5)
        continue
    listener.close()
    raise SystemExit(0)
raise SystemExit(1)
PY
}

forward_is_running() {
  awk -v sandbox="$1" -v port="$2" '
    $1 == sandbox && $3 == port && tolower($0) ~ /(running|active)/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

forward_is_absent() {
  awk -v sandbox="$1" -v port="$2" '
    $1 == sandbox && $3 == port && tolower($0) ~ /(running|active)/ { found = 1 }
    END { exit(found ? 1 : 0) }
  '
}

wait_for_ready
"$openshell" forward start --background "$dashboard_port" "$sandbox_name" --gateway "$gateway"
"$openshell" forward start --background "$unregistered_port" "$sandbox_name" --gateway "$gateway"
seeded="$("$openshell" forward list --gateway "$gateway")"
printf '%s\n' "$seeded"
printf '%s\n' "$seeded" | forward_is_running "$sandbox_name" "$dashboard_port"
printf '%s\n' "$seeded" | forward_is_running "$sandbox_name" "$unregistered_port"
wait_for_reachable "$dashboard_port"
wait_for_reachable "$unregistered_port"
printf 'LEGACY_FORWARDS_SEEDED=%s,%s\n' "$dashboard_port" "$unregistered_port"

"$nemoclaw" "$sandbox_name" recover
migrated="$("$openshell" forward list --gateway "$gateway")"
printf '%s\n' "$migrated"
printf '%s\n' "$migrated" | forward_is_absent "$sandbox_name" "$dashboard_port"
printf '%s\n' "$migrated" | forward_is_running "$sandbox_name" "$unregistered_port"
wait_for_reachable "$dashboard_port"
wait_for_reachable "$unregistered_port"
printf 'LEGACY_REGISTERED_REMOVED=%s\n' "$dashboard_port"
printf 'UNREGISTERED_FORWARD_PRESERVED=%s\n' "$unregistered_port"
printf 'FORWARD_SERVICE_REACHABLE=%s\n' "$dashboard_port"

"$openshell" forward stop "$unregistered_port" "$sandbox_name" --gateway "$gateway"
wait_for_free "$unregistered_port"
"$nemoclaw" "$sandbox_name" stop
wait_for_free "$dashboard_port"
printf 'MIGRATED_FORWARD_RELEASED=%s\n' "$dashboard_port"`,
      "legacy-forward-migrate-and-stop",
      host.commandPath,
      host.openshellCommandPath,
      LEGACY_FORWARD_SANDBOX,
      String(LEGACY_DASHBOARD_PORT),
      String(LEGACY_UNREGISTERED_PORT),
      "nemoclaw",
    ],
    {
      artifactName: "legacy-forward-migrate-and-verify",
      env: migrationEnv,
      redactionValues: [hosted.apiKey],
      timeoutMs: 15 * 60_000,
    },
  );
  expect(migrate.exitCode, resultText(migrate)).toBe(0);
}

test(
  "migrates only the registered legacy dashboard forward to the direct ForwardTcp service",
  {
    timeout: testTimeout(45 * 60_000),
    meta: {
      e2ePhases: [
        "onboard the legacy migration sandbox",
        "seed, migrate, and release the legacy dashboard forward",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const migrationEnv = legacyForwardEnvironment(hosted);

    await artifacts.target.declare({
      id: "sandbox-operations",
      boundary: "real-openshell-legacy-forward-to-direct-forwardtcp-service",
      sandboxName: LEGACY_FORWARD_SANDBOX,
      dashboardPort: LEGACY_DASHBOARD_PORT,
      contracts: [
        "a real tracked openshell forward start --background entry owns the registered dashboard port",
        "normal NemoClaw recovery removes that exact legacy entry and launches ForwardTcp service",
        "an unregistered legacy forward for the same sandbox is preserved",
        "stopping the migrated sandbox releases the ForwardTcp service port naturally",
        "terminal cleanup removes every sandbox, forward, listener, and gateway created by the test",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "legacy-forward-prereq-runtime-provider-info",
      scenarioLabel: "legacy forward migration",
    });
    await host.bestEffortCleanupSandbox(LEGACY_FORWARD_SANDBOX, {
      artifactName: "legacy-forward-precleanup-nemoclaw-sandbox",
      env: migrationEnv,
    });
    await sandbox
      .cleanupSandbox(LEGACY_FORWARD_SANDBOX, {
        artifactName: "legacy-forward-precleanup-openshell-sandbox",
        env: migrationEnv,
        timeoutMs: 120_000,
      })
      .catch(() => undefined);
    await host
      .cleanupForward(LEGACY_DASHBOARD_PORT, {
        artifactName: "legacy-forward-precleanup-dashboard-forward",
        env: migrationEnv,
      })
      .catch(() => undefined);
    await host
      .cleanupForward(LEGACY_UNREGISTERED_PORT, {
        artifactName: "legacy-forward-precleanup-unregistered-forward",
        env: migrationEnv,
      })
      .catch(() => undefined);

    cleanup.trackGateway(host, "nemoclaw", {
      env: migrationEnv,
      redactionValues: [hosted.apiKey],
      timeoutMs: 5 * 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${LEGACY_FORWARD_SANDBOX}`, () =>
      sandbox.cleanupSandbox(LEGACY_FORWARD_SANDBOX, {
        artifactName: "legacy-forward-cleanup-openshell-sandbox",
        env: migrationEnv,
        redactionValues: [hosted.apiKey],
        timeoutMs: 120_000,
      }),
    );
    cleanup.trackForward(host, LEGACY_DASHBOARD_PORT, {
      artifactName: "legacy-forward-cleanup-dashboard-forward",
      env: migrationEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackForward(host, LEGACY_UNREGISTERED_PORT, {
      artifactName: "legacy-forward-cleanup-unregistered-forward",
      env: migrationEnv,
      timeoutMs: 60_000,
    });

    progress.phase("onboard the legacy migration sandbox");
    await onboardSandbox(
      host,
      cleanup,
      LEGACY_FORWARD_SANDBOX,
      "legacy-forward-onboard-sandbox",
      hosted,
      { NEMOCLAW_DASHBOARD_PORT: String(LEGACY_DASHBOARD_PORT) },
    );

    progress.phase("seed, migrate, and release the legacy dashboard forward");
    await runLegacyForwardMigration(host, runtimeProvider, hosted);

    await artifacts.target.complete({
      id: "sandbox-operations",
      status: "passed",
      registeredLegacyForwardSeeded: true,
      registeredLegacyForwardRemoved: true,
      unregisteredLegacyForwardPreserved: true,
      forwardTcpServiceReachable: true,
      migratedSandboxPortReleasedAfterStop: true,
    });
  },
);

test(
  "credentials reset removes a provider attached during sandbox rebuild (#9806)",
  {
    timeout: 45 * 60_000,
    meta: {
      e2ePhases: [
        "confirm Docker and clear the credential provider fixture",
        "onboard the credential lifecycle sandbox",
        "add, attach, reset, and remove the credential provider",
      ],
    },
  },
  async ({ artifacts, cleanup, docker, environment, host, progress, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);

    await artifacts.target.declare({
      id: "sandbox-operations",
      boundary: "repo-cli-openshell-provider-sandbox-attachment",
      contracts: [
        "TC-SBX-14 credentials add/list/reset crosses the real OpenShell provider boundary, keeps the credential outside the rebuilt sandbox, and removes the attachment and provider",
      ],
    });

    artifacts.addRedactionValues([CREDENTIAL_VALUE]);
    await docker.requireDocker();
    await environment.assertReady(ENVIRONMENT);
    cleanup.trackGateway(host, "nemoclaw", {
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 5 * 60_000,
    });
    await host.cleanupSandbox(SANDBOX_A);
    await resetCredentialProvider(host, "tc-sbx-14-clear-stale-credential-provider");
    cleanup.add(`remove credential provider ${CREDENTIAL_PROVIDER}`, async () => {
      await resetCredentialProvider(host, "cleanup-tc-sbx-14-credential-provider");
    });

    progress.phase("onboard the credential lifecycle sandbox");
    await onboardSandbox(host, cleanup, SANDBOX_A, "tc-sbx-14-onboard-sandbox", hosted);

    progress.phase("add, attach, reset, and remove the credential provider");
    const add = await host.nemoclaw(
      [
        "credentials",
        "add",
        CREDENTIAL_PROVIDER,
        "--type",
        "tavily",
        "--credential",
        CREDENTIAL_ENV_NAME,
      ],
      {
        artifactName: "tc-sbx-14-credentials-add",
        env: {
          ...buildAvailabilityProbeEnv(),
          [CREDENTIAL_ENV_NAME]: CREDENTIAL_VALUE,
        },
        redactionValues: [CREDENTIAL_VALUE],
        timeoutMs: 3 * 60_000,
      },
    );
    expectExitZero(add, `nemoclaw credentials add ${CREDENTIAL_PROVIDER}`);
    expect(resultText(add)).toContain(`Registered provider '${CREDENTIAL_PROVIDER}'`);
    expect(resultText(add)).not.toContain(CREDENTIAL_VALUE);

    const beforeRebuild = await host.nemoclaw(["credentials", "list"], {
      artifactName: "tc-sbx-14-credentials-list-before-rebuild",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expectExitZero(beforeRebuild, "nemoclaw credentials list before rebuild");
    expect(resultText(beforeRebuild)).toContain(CREDENTIAL_PROVIDER);

    const rebuild = await host.nemoclaw([SANDBOX_A, "rebuild", "--yes"], {
      artifactName: "tc-sbx-14-rebuild-with-credential-provider",
      env: {
        ...buildAvailabilityProbeEnv(),
        ...hosted.env,
      },
      redactionValues: [hosted.apiKey, CREDENTIAL_VALUE],
      timeoutMs: 20 * 60_000,
    });
    expectExitZero(rebuild, `nemoclaw ${SANDBOX_A} rebuild --yes`);
    expect(resultText(rebuild)).not.toContain(CREDENTIAL_VALUE);

    await expectSandboxProviderAttachment(sandbox, SANDBOX_A, CREDENTIAL_PROVIDER, "present", {
      artifactName: "tc-sbx-14-provider-attached-after-rebuild",
      env: buildAvailabilityProbeEnv(),
    });
    await assertCredentialRemainsOutsideSandbox(sandbox);

    const reset = await resetCredentialProvider(host, "tc-sbx-14-credentials-reset-attached");
    expect(resultText(reset)).toContain(`Removed provider '${CREDENTIAL_PROVIDER}'`);
    await expectSandboxProviderAttachment(sandbox, SANDBOX_A, CREDENTIAL_PROVIDER, "absent", {
      artifactName: "tc-sbx-14-provider-detached-after-reset",
      env: buildAvailabilityProbeEnv(),
    });

    const afterReset = await host.nemoclaw(["credentials", "list"], {
      artifactName: "tc-sbx-14-credentials-list-after-reset",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expectExitZero(afterReset, "nemoclaw credentials list after reset");
    expect(resultText(afterReset)).not.toContain(CREDENTIAL_PROVIDER);
  },
);

test(
  "sandbox operations preserve list/status/logs/recovery/multi-sandbox contracts",
  {
    timeout: testTimeout(45 * 60_000),
    meta: {
      e2ePhases: [
        "confirm Docker and clear the sandbox operation fixtures",
        "onboard the primary sandbox",
        "validate connected shell resource limits",
        "exercise primary CLI inference and logs",
        "exercise terminal registry and process recovery",
        "onboard the secondary sandbox",
        "verify metadata and cross-sandbox isolation",
        "destroy the secondary sandbox and recover the survivor",
        "destroy the final sandbox and confirm port release",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    environment,
    host,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
  }) => {
    const hosted = requireHostedInferenceConfig(secrets);

    await artifacts.target.declare({
      id: "sandbox-operations",
      boundary: "repo-cli-docker-openshell-sandbox",
      contracts: [
        "TC-SBX-01 list shows onboarded sandbox",
        "TC-SBX-02 nemoclaw <sandbox> agent --json answers through sandbox inference.local",
        "TC-SBX-02b agent --json preserves nonzero transport status",
        "TC-SBX-03 status renders Sandbox/Model/Provider/GPU fields",
        "TC-SBX-04 logs and logs --follow behave as streaming commands",
        "TC-SBX-05 destroy removes NemoClaw and OpenShell entries",
        "TC-SBX-06 status recovers after gateway container kill",
        "TC-SBX-07 list rebuilds registry from live state",
        "TC-SBX-08 status recovers killed in-sandbox OpenClaw gateway process",
        "TC-SBX-08b forced OpenClaw gateway restart replaces only the gateway and preserves live inference",
        "TC-SBX-09 tmux and PTY lifecycle work inside sandbox",
        "TC-SBX-10 two sandboxes list with model/provider metadata",
        "TC-SBX-11 sandboxes cannot reach each other by hostname",
        "TC-SBX-12 destroying the non-final sandbox preserves the survivor and final destroy releases the gateway port through the macOS default or explicit non-macOS cleanup",
        "TC-SBX-13 bare connect routes to the default sandbox and enforces login and interactive shell resource limits without startup diagnostics (#2173)",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-provider-info",
      scenarioLabel: "sandbox operations",
    });

    await environment.assertReady(ENVIRONMENT);
    cleanup.trackGateway(host, "nemoclaw", {
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 5 * 60_000,
    });
    await host.cleanupSandbox(SANDBOX_B);
    await host.cleanupSandbox(SANDBOX_A);

    progress.phase("onboard the primary sandbox");
    await onboardSandbox(host, cleanup, SANDBOX_A, "onboard-sandbox-a", hosted);

    progress.phase("validate connected shell resource limits");
    const connectRlimitSummary = await assertConnectResourceLimits(host);
    await artifacts.writeText("connect-rlimits-summary.txt", connectRlimitSummary);

    progress.phase("exercise primary CLI inference and logs");
    await expectListed(host, SANDBOX_A, "tc-sbx-01-list-sandbox-a");
    await assertAgentCanAnswer(host, SANDBOX_A);
    await assertAgentJsonNonzeroExit(host, SANDBOX_A);
    await assertStatusFields(host, SANDBOX_A);
    await assertLogsStream(host, SANDBOX_A);

    progress.phase("exercise terminal registry and process recovery");
    await assertTmuxPtyFlow(sandbox, SANDBOX_A);
    await assertRegistryRebuild(host, SANDBOX_A);
    await assertForcedGatewayRestart(host, sandbox, SANDBOX_A);
    await assertProcessRecovery(host, sandbox, SANDBOX_A);

    progress.phase("onboard the secondary sandbox");
    await onboardSandbox(host, cleanup, SANDBOX_B, "tc-sbx-10-onboard-sandbox-b", hosted, {
      CHAT_UI_URL: "http://127.0.0.1:18790",
    });

    progress.phase("verify metadata and cross-sandbox isolation");
    await assertMetadataForBothSandboxes(host, SANDBOX_A, SANDBOX_B);
    await assertNetworkIsolation(sandbox, SANDBOX_A, SANDBOX_B, "tc-sbx-11-a-cannot-reach-b");
    await assertNetworkIsolation(sandbox, SANDBOX_B, SANDBOX_A, "tc-sbx-11-b-cannot-reach-a");

    progress.phase("destroy the secondary sandbox and recover the survivor");
    await assertDestroyRemovesSandbox(host, sandbox, SANDBOX_B);
    await expectListed(host, SANDBOX_A, "tc-sbx-12-survivor-listed-after-destroy-b");
    await assertAgentCanAnswer(host, SANDBOX_A, "tc-sbx-12-survivor-agent-after-destroy-b");

    const gatewayRecovery = await assertGatewayRecovery(host, runtimeProvider, SANDBOX_A);
    const finalDestroyCleanupMode =
      process.platform === "darwin" ? "macos-default" : "explicit-non-macos";

    progress.phase("destroy the final sandbox and confirm port release");
    await assertDestroyRemovesSandbox(host, sandbox, SANDBOX_A, {
      cleanupGateway: finalDestroyCleanupMode === "explicit-non-macos",
    });
    await expectHostPortFree(host, GATEWAY_PORT, "tc-sbx-12-final-destroy-gateway-port-free");

    await artifacts.target.complete({
      id: "sandbox-operations",
      status: "passed",
      finalDestroyCleanupMode,
      finalGatewayPortReleased: true,
      gatewayRecovery,
      connectRlimitsValidated: true,
      legacySource: "test/e2e/test-sandbox-operations.sh",
    });
  },
);
