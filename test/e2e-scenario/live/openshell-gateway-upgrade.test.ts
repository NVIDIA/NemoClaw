// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-openshell-gateway-upgrade.sh.
 *
 * Preserves the PR #3001 contract at the same boundary as the legacy shell
 * lane: install an old NemoClaw/OpenShell gateway, create a real OpenClaw
 * sandbox, seed durable workspace + live process state, run the current
 * installer upgrade path, then assert the gateway reports the current
 * OpenShell version and the survivor claw remains restored/reachable.
 *
 * The macOS regressions from the shell script remain hermetic installer-script
 * probes in this file: fake Darwin arm64 PATH, fake existing OpenShell tools,
 * real scripts/install-openshell.sh execution, and static Dockerfile guard
 * assertions. No new fixture family or migration ledger is introduced.
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const INSTALL_OPENSHELL = path.join(REPO_ROOT, "scripts", "install-openshell.sh");
const STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
);
const PID_FILE = path.join(STATE_DIR, "openshell-gateway.pid");
const OLD_NEMOCLAW_REF = process.env.NEMOCLAW_OLD_NEMOCLAW_REF ?? "v0.0.36";
const OLD_OPENSHELL_VERSION = process.env.NEMOCLAW_OLD_OPENSHELL_VERSION ?? "0.0.36";
const CURRENT_OPENSHELL_VERSION = process.env.NEMOCLAW_CURRENT_OPENSHELL_VERSION ?? "0.0.44";
const OLD_SANDBOX_BASE_IMAGE_REF =
  process.env.NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF ??
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:104151ffadc2ff0b6c815e3c95c2783ced61aee0d0f83fc327cc02be9b7e14e6";
const OLD_OPENCLAW_VERSION = process.env.NEMOCLAW_OLD_OPENCLAW_VERSION ?? "2026.4.24";
const SURVIVOR_SANDBOX =
  process.env.NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME ??
  [
    "e2e-gateway-upgrade-survivor",
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    process.pid,
  ]
    .filter(Boolean)
    .join("-");
const SURVIVOR_MARKER = `gateway-upgrade-survivor-${Date.now()}`;
const SURVIVOR_MARKER_PATH = "/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-marker";
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const TEST_TIMEOUT_MS = 60 * 60_000;
const INSTALL_TIMEOUT_MS = 35 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;

validateSandboxName(SURVIVOR_SANDBOX);
expect(
  SURVIVOR_SANDBOX.startsWith("e2e-gateway-upgrade-survivor"),
  `openshell-gateway-upgrade live test only accepts survivor sandbox names with prefix e2e-gateway-upgrade-survivor; got ${SURVIVOR_SANDBOX}`,
).toBe(true);

function writeExecutable(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    ...extra,
  };
}

function shellLoginPrefix(): string {
  return [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then',
    "  # shellcheck source=/dev/null",
    '  source "$HOME/.bashrc" 2>/dev/null || true',
    "fi",
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then',
    "  # shellcheck source=/dev/null",
    '  . "$NVM_DIR/nvm.sh"',
    "fi",
    'export PATH="$HOME/.local/bin:$PATH"',
  ].join("\n");
}

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label} failed:\n${resultText(result)}`).toBe(0);
}

function expectOutputContains(result: ShellProbeResult, value: string, label: string): void {
  expect(resultText(result), label).toContain(value);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function bash(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    cwd?: string;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", `${shellLoginPrefix()}\n${script}`], {
    cwd: options.cwd ?? REPO_ROOT,
    artifactName: options.artifactName,
    env: options.env ?? liveEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? OPENSHELL_TIMEOUT_MS,
  });
}

function patchOldInstallerFixture(installer: string): void {
  const needle = '  legacy_script="${source_root}/install.sh"\n';
  const hook =
    String.raw`  if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" && -f "$payload_script" ]]; then
    python3 - "$payload_script" <<'NEMOCLAW_OLD_PAYLOAD_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '    spin "Cloning \${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"\n'
hook = r'''    if [[ -n "\${NEMOCLAW_OLD_OPENCLAW_VERSION:-}" ]]; then
      python3 - "$nemoclaw_src/Dockerfile" "$NEMOCLAW_OLD_OPENCLAW_VERSION" <<'NEMOCLAW_OLD_DOCKERFILE_PIN_PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
marker = "RUN set -eu; \\\n    MIN_VER=$(grep -m 1 'min_openclaw_version'"
injection = (
    "# E2E old-upgrade fixture: force the historical OpenClaw before the old Dockerfile's version gate.\n"
    "RUN rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw \\\n"
    f"    && npm install -g --no-audit --no-fund --no-progress \"openclaw@{version}\" \\\n"
    "    && openclaw --version\n\n"
)
if injection not in text:
    if marker not in text:
        raise SystemExit(f"{path}: old OpenClaw version gate not found")
    text = text.replace(marker, injection + marker, 1)
    path.write_text(text, encoding="utf-8")
print(f"INFO: Forced OpenClaw {version} in old upgrade fixture Dockerfile", flush=True)
NEMOCLAW_OLD_DOCKERFILE_PIN_PY
    fi
'''
if hook not in text:
    if needle not in text:
        raise SystemExit(f"{path}: old source clone hook not found")
    text = text.replace(needle, needle + hook, 1)
    path.write_text(text, encoding="utf-8")
NEMOCLAW_OLD_PAYLOAD_PIN_PY
  fi
`.replaceAll("\\${", "${");

  const text = fs.readFileSync(installer, "utf8");
  const patchedText = text.includes(hook)
    ? text
    : text.includes(needle)
      ? text.replace(needle, needle + hook)
      : (() => {
          throw new Error(`${installer}: old bootstrap payload hook not found`);
        })();
  fs.writeFileSync(installer, patchedText, "utf8");
}

function createOldDockerWrapper(artifacts: ArtifactSink): string {
  const wrapperDir = artifacts.pathFor("old-docker-wrapper");
  fs.mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
  writeExecutable(
    path.join(wrapperDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
real_docker="\${NEMOCLAW_REAL_DOCKER:-/usr/bin/docker}"
base_ref="\${NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF:?}"
old_openclaw="\${NEMOCLAW_OLD_OPENCLAW_VERSION:?}"
log_file="\${NEMOCLAW_OLD_DOCKER_WRAPPER_LOG:?}"
base_tag="ghcr.io/nvidia/nemoclaw/sandbox-base:latest"
if [ "\${1:-}" = "pull" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$base_tag" ]; then
      printf 'rewrite pull %s -> %s\n' "$base_tag" "$base_ref" >>"$log_file"
      "$real_docker" pull "$base_ref"
      "$real_docker" tag "$base_ref" "$base_tag"
      exit 0
    fi
  done
fi
if [ "\${1:-}" != "build" ]; then
  exec "$real_docker" "$@"
fi

args=()
rewrote_openclaw=0
rewrote_base=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-arg)
      if [ "$#" -ge 2 ] && [ "\${2#OPENCLAW_VERSION=}" != "$2" ]; then
        args+=("--build-arg" "OPENCLAW_VERSION=\${old_openclaw}")
        rewrote_openclaw=1
        printf 'rewrite build-arg %s -> OPENCLAW_VERSION=%s\n' "$2" "$old_openclaw" >>"$log_file"
        shift 2
        continue
      fi
      if [ "$#" -ge 2 ] && [ "\${2#BASE_IMAGE=}" != "$2" ]; then
        args+=("--build-arg" "BASE_IMAGE=\${base_ref}")
        rewrote_base=1
        printf 'rewrite build-arg %s -> BASE_IMAGE=%s\n' "$2" "$base_ref" >>"$log_file"
        shift 2
        continue
      fi
      ;;
    --build-arg=OPENCLAW_VERSION=*)
      args+=("--build-arg=OPENCLAW_VERSION=\${old_openclaw}")
      rewrote_openclaw=1
      printf 'rewrite build-arg %s -> OPENCLAW_VERSION=%s\n' "$1" "$old_openclaw" >>"$log_file"
      shift
      continue
      ;;
    --build-arg=BASE_IMAGE=*)
      args+=("--build-arg=BASE_IMAGE=\${base_ref}")
      rewrote_base=1
      printf 'rewrite build-arg %s -> BASE_IMAGE=%s\n' "$1" "$base_ref" >>"$log_file"
      shift
      continue
      ;;
  esac
  args+=("$1")
  shift
done
if [ "$rewrote_openclaw" = "0" ]; then
  args+=("--build-arg" "OPENCLAW_VERSION=\${old_openclaw}")
  printf 'add build-arg OPENCLAW_VERSION=%s\n' "$old_openclaw" >>"$log_file"
fi
if [ "$rewrote_base" = "0" ]; then
  args+=("--build-arg" "BASE_IMAGE=\${base_ref}")
  printf 'add build-arg BASE_IMAGE=%s\n' "$base_ref" >>"$log_file"
fi
exec "$real_docker" "\${args[@]}"
`,
  );
  return wrapperDir;
}

async function waitForSurvivorReady(host: HostCliClient, labelPrefix: string): Promise<void> {
  let attempt = 0;
  let ready = false;
  while (attempt < 60 && !ready) {
    const result = await bash(host, `openshell sandbox list 2>/dev/null || true`, {
      artifactName: `${labelPrefix}-sandbox-list-${attempt}`,
      timeoutMs: 30_000,
    });
    ready = new RegExp(`${SURVIVOR_SANDBOX}.*Ready`).test(resultText(result));
    attempt += 1;
    ready || (await new Promise<void>((resolve) => setTimeout(resolve, 2_000)));
  }
  expect(ready, `survivor sandbox ${SURVIVOR_SANDBOX} did not become Ready`).toBe(true);
}

async function survivorAgentProbe(
  host: HostCliClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  const probe = [
    'pid="$(cat /tmp/nemoclaw-e2e-agent.pid 2>/dev/null || true)"',
    '[ -n "$pid" ] || exit 1',
    'kill -0 "$pid" 2>/dev/null || exit 1',
    "counter=\"$(sed -n 's/^[^ ]* \\([0-9][0-9]*\\).*/\\1/p' /tmp/nemoclaw-e2e-agent.heartbeat 2>/dev/null | head -1)\"",
    "cmdline=\"$(tr '\\000' ' ' <\"/proc/${pid}/cmdline\" 2>/dev/null || true)\"",
    'case "$cmdline" in *nemoclaw-e2e-agent*) ;; *) exit 1 ;; esac',
    'printf "%s %s %s\\n" "$pid" "${counter:-0}" "$cmdline"',
  ].join("; ");
  return bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc ${shellQuote(probe)}`,
    { artifactName, timeoutMs: 30_000 },
  );
}

async function waitForSurvivorAgentReady(host: HostCliClient): Promise<ShellProbeResult> {
  let last: ShellProbeResult | undefined;
  let attempt = 0;
  while (attempt < 60 && last?.exitCode !== 0) {
    last = await survivorAgentProbe(host, `survivor-agent-probe-${attempt}`);
    attempt += 1;
    last.exitCode === 0 || (await new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
  }
  expect(
    last?.exitCode,
    `survivor agent did not become healthy: ${last ? resultText(last) : "no probe"}`,
  ).toBe(0);
  return last!;
}

async function runInstallerPayload(
  host: HostCliClient,
  label: string,
  installer: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
  redactionValues: string[] = [],
): Promise<ShellProbeResult> {
  const result = await bash(
    host,
    `rm -f ${shellQuote(logFile)}
bash ${shellQuote(installer)} --non-interactive --yes-i-accept-third-party-software >${shellQuote(logFile)} 2>&1`,
    {
      artifactName: `${label.replace(/[^a-z0-9_.-]+/gi, "-")}-installer`,
      env,
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  const tail = await bash(host, `tail -160 ${shellQuote(logFile)} 2>/dev/null || true`, {
    artifactName: `${label}-installer-tail`,
    timeoutMs: 30_000,
  });
  expect(result.exitCode, `${label} NemoClaw installer failed:\n${resultText(tail)}`).toBe(0);
  return result;
}

async function installOldNemoclawAndClaw(
  host: HostCliClient,
  artifacts: ArtifactSink,
  fakeBaseUrl: string,
): Promise<void> {
  const oldInstaller = artifacts.pathFor("old-install.sh");
  const oldInstallLog = artifacts.pathFor("old-install.log");
  const oldDockerLog = artifacts.pathFor("old-docker-wrapper.log");
  const wrapperDir = createOldDockerWrapper(artifacts);
  fs.rmSync(oldDockerLog, { force: true });

  const download = await bash(
    host,
    `curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/${shellQuote(OLD_NEMOCLAW_REF)}/install.sh -o ${shellQuote(oldInstaller)}
chmod 755 ${shellQuote(oldInstaller)}`,
    { artifactName: "download-old-installer", timeoutMs: 90_000 },
  );
  expectExitZero(download, `download old ${OLD_NEMOCLAW_REF} installer`);
  patchOldInstallerFixture(oldInstaller);

  const installEnv = liveEnv({
    PATH: `${wrapperDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_REAL_DOCKER: process.env.NEMOCLAW_REAL_DOCKER ?? "/usr/bin/docker",
    NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF: OLD_SANDBOX_BASE_IMAGE_REF,
    NEMOCLAW_OLD_OPENCLAW_VERSION: OLD_OPENCLAW_VERSION,
    NEMOCLAW_OLD_DOCKER_WRAPPER_LOG: oldDockerLog,
    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
    NEMOCLAW_INSTALL_REF: OLD_NEMOCLAW_REF,
    NEMOCLAW_INSTALL_TAG: OLD_NEMOCLAW_REF,
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: SURVIVOR_SANDBOX,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
  });

  await runInstallerPayload(
    host,
    `old-${OLD_NEMOCLAW_REF}`,
    oldInstaller,
    oldInstallLog,
    installEnv,
  );
  await artifacts.writeText(
    "old-docker-wrapper.log",
    fs.existsSync(oldDockerLog) ? fs.readFileSync(oldDockerLog, "utf8") : "",
  );

  const oldLog = fs.readFileSync(oldInstallLog, "utf8");
  const oldOpenClawVersionPattern = escapeRegExpLiteral(OLD_OPENCLAW_VERSION);
  const wrongOldOpenClaw = oldLog.match(
    new RegExp(
      `OpenClaw ((?!${oldOpenClawVersionPattern})[0-9]{4}\\.[0-9]+\\.[0-9]+) is current \\(>= ${oldOpenClawVersionPattern}\\)`,
    ),
  );
  expect(
    wrongOldOpenClaw?.[1],
    `old fixture log must not use an unexpected OpenClaw version:\n${oldLog}`,
  ).toBeUndefined();
  expect(oldLog, `old fixture must show pinned OpenClaw ${OLD_OPENCLAW_VERSION}`).toMatch(
    new RegExp(`OpenClaw ${oldOpenClawVersionPattern}|openclaw@${oldOpenClawVersionPattern}`),
  );

  const openshellVersion = await bash(host, `openshell --version`, {
    artifactName: "old-openshell-version",
    timeoutMs: 30_000,
  });
  expectExitZero(openshellVersion, "old openshell --version");
  expectOutputContains(
    openshellVersion,
    OLD_OPENSHELL_VERSION,
    `old NemoClaw install must leave OpenShell ${OLD_OPENSHELL_VERSION}`,
  );

  const sourceHead = await bash(
    host,
    `if [ -d "$HOME/.nemoclaw/source/.git" ]; then git -C "$HOME/.nemoclaw/source" rev-parse HEAD; fi`,
    { artifactName: "old-source-head", timeoutMs: 30_000 },
  );
  const expectedHead = await bash(
    host,
    `git ls-remote https://github.com/NVIDIA/NemoClaw.git refs/tags/${shellQuote(OLD_NEMOCLAW_REF)} | awk '{print $1}'`,
    { artifactName: "old-source-expected-head", timeoutMs: 60_000 },
  );
  expectExitZero(sourceHead, "read old source head");
  expectExitZero(expectedHead, "read expected old tag head");
  expect(sourceHead.stdout.trim()).toBe(expectedHead.stdout.trim());

  await waitForSurvivorReady(host, "old-install");
  const list = await bash(host, `nemoclaw list`, {
    artifactName: "old-nemoclaw-list",
    timeoutMs: 60_000,
  });
  expectExitZero(list, "old nemoclaw list");
  expectOutputContains(list, SURVIVOR_SANDBOX, "old NemoClaw install must register survivor claw");
}

async function startSurvivorAgentInExistingClaw(host: HostCliClient): Promise<number> {
  const markerResult = await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc ${shellQuote(`mkdir -p /sandbox/.openclaw/workspace && printf '%s\\n' ${shellQuote(SURVIVOR_MARKER)} >${shellQuote(SURVIVOR_MARKER_PATH)}`)}`,
    { artifactName: "write-survivor-marker", timeoutMs: 60_000 },
  );
  expectExitZero(markerResult, "write survivor marker before gateway upgrade");

  const agentPayload = Buffer.from(
    [
      "#!/bin/sh",
      "set -eu",
      'pid_file="/tmp/nemoclaw-e2e-agent.pid"',
      'heartbeat_file="/tmp/nemoclaw-e2e-agent.heartbeat"',
      'events_file="/tmp/nemoclaw-e2e-agent.events"',
      'printf \'%s\\n\' "$$" >"$pid_file"',
      'printf \'started %s\\n\' "$$" >>"$events_file"',
      "counter=0",
      'trap \'printf "stopped %s\\n" "$$" >>"$events_file"; exit 0\' TERM INT',
      "while true; do",
      "  counter=$((counter + 1))",
      '  printf \'%s %s %s\\n\' "$$" "$counter" "$(date +%s)" >"$heartbeat_file"',
      "  sleep 1",
      "done",
      "",
    ].join("\n"),
    "utf8",
  ).toString("base64");
  const remoteSetup = `printf '%s' ${shellQuote(agentPayload)} | base64 -d >/tmp/nemoclaw-e2e-agent; chmod 755 /tmp/nemoclaw-e2e-agent; rm -f /tmp/nemoclaw-e2e-agent.pid /tmp/nemoclaw-e2e-agent.heartbeat /tmp/nemoclaw-e2e-agent.events /tmp/nemoclaw-e2e-agent.log; nohup /tmp/nemoclaw-e2e-agent >/tmp/nemoclaw-e2e-agent.log 2>&1 &`;
  const startResult = await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc ${shellQuote(remoteSetup)}`,
    { artifactName: "start-survivor-agent", timeoutMs: 60_000 },
  );
  expectExitZero(startResult, "start survivor agent before gateway upgrade");
  const probe = await waitForSurvivorAgentReady(host);
  const pid = Number.parseInt(probe.stdout.trim().split(/\s+/)[0] ?? "", 10);
  expect(
    Number.isInteger(pid) && pid > 0,
    `survivor agent pid must be present:\n${probe.stdout}`,
  ).toBe(true);
  return pid;
}

async function installCurrentNemoclawUpgrade(
  host: HostCliClient,
  fakeBaseUrl: string,
  currentInstallLog: string,
): Promise<void> {
  const currentRef = process.env.NEMOCLAW_CURRENT_NEMOCLAW_REF ?? process.env.GITHUB_SHA ?? "HEAD";
  const currentRefResult = await bash(
    host,
    currentRef === "HEAD" ? "git rev-parse HEAD" : `printf '%s' ${shellQuote(currentRef)}`,
    {
      artifactName: "current-ref",
      timeoutMs: 30_000,
    },
  );
  expectExitZero(currentRefResult, "resolve current NemoClaw ref");
  const resolvedRef = currentRefResult.stdout.trim();
  expect(resolvedRef.length).toBeGreaterThan(0);
  const currentEnv = liveEnv({
    COMPATIBLE_API_KEY: "dummy",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
    NEMOCLAW_INSTALL_REF: resolvedRef,
    NEMOCLAW_INSTALL_TAG: resolvedRef,
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: SURVIVOR_SANDBOX,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
  });
  const redactionValues = [process.env.GITHUB_TOKEN ?? ""].filter(Boolean);
  await runInstallerPayload(
    host,
    `current-${resolvedRef.slice(0, 12)}`,
    path.join(REPO_ROOT, "scripts", "install.sh"),
    currentInstallLog,
    currentEnv,
    redactionValues,
  );

  const currentLog = fs.readFileSync(currentInstallLog, "utf8");
  expect(currentLog).toContain("Accepted experimental OpenShell gateway upgrade");
  expect(currentLog).toContain("Pre-upgrade backup: 1 backed up, 0 failed, 0 skipped");

  const openshellVersion = await bash(host, `openshell --version`, {
    artifactName: "current-openshell-version",
    redactionValues,
    timeoutMs: 30_000,
  });
  expectExitZero(openshellVersion, "current openshell --version");
  expectOutputContains(
    openshellVersion,
    CURRENT_OPENSHELL_VERSION,
    `current NemoClaw install must upgrade OpenShell to ${CURRENT_OPENSHELL_VERSION}`,
  );

  const status = await bash(host, `openshell status`, {
    artifactName: "current-openshell-status",
    timeoutMs: 60_000,
  });
  expectExitZero(status, "openshell status after current install");
  expect(resultText(status)).toMatch(
    new RegExp(`Version:.*${escapeRegExpLiteral(CURRENT_OPENSHELL_VERSION)}`),
  );
}

async function assertSurvivorSandboxAfterUpgrade(host: HostCliClient): Promise<void> {
  await waitForSurvivorReady(host, "post-upgrade");

  const marker = await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- cat ${shellQuote(SURVIVOR_MARKER_PATH)}`,
    { artifactName: "post-upgrade-survivor-marker", timeoutMs: 60_000 },
  );
  expectExitZero(marker, "read survivor marker after gateway upgrade");
  expect(marker.stdout.trim()).toBe(SURVIVOR_MARKER);

  const agentCheck = await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc 'command -v openclaw >/dev/null && test -s /sandbox/.openclaw/openclaw.json && openclaw --version 2>/dev/null'`,
    { artifactName: "post-upgrade-openclaw-agent", timeoutMs: 60_000 },
  );
  expectExitZero(
    agentCheck,
    "OpenClaw agent must remain installed/configured after gateway upgrade",
  );
  expect(agentCheck.stdout.trim().length).toBeGreaterThan(0);

  expect(fs.existsSync(REGISTRY_FILE), `${REGISTRY_FILE} must exist after upgrade`).toBe(true);
  expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toContain(`"${SURVIVOR_SANDBOX}"`);

  const list = await bash(host, `nemoclaw list`, {
    artifactName: "post-upgrade-nemoclaw-list",
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list after gateway upgrade");
  expectOutputContains(list, SURVIVOR_SANDBOX, "nemoclaw list must still show survivor sandbox");
}

function runMacInstallerProbe(
  artifacts: ArtifactSink,
  name: string,
  setup: (fakeBin: string, tmp: string) => Record<string, string>,
): ReturnType<typeof spawnSync> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-${name}-`));
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const extraEnv = setup(fakeBin, tmp);
  const result = spawnSync("bash", [INSTALL_OPENSHELL], {
    env: {
      ...process.env,
      ...extraEnv,
      NEMOCLAW_OPENSHELL_CHANNEL: "stable",
      PATH: `${fakeBin}:/usr/bin:/bin`,
    },
    encoding: "utf8",
  });
  fs.mkdirSync(artifacts.pathFor(`macos-${name}`), { recursive: true });
  fs.writeFileSync(artifacts.pathFor(`macos-${name}/stdout.txt`), result.stdout ?? "", "utf8");
  fs.writeFileSync(artifacts.pathFor(`macos-${name}/stderr.txt`), result.stderr ?? "", "utf8");
  return result;
}

function writeFakeDarwinUname(fakeBin: string): void {
  writeExecutable(
    path.join(fakeBin, "uname"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then
  printf 'arm64\n'
else
  printf 'Darwin\n'
fi
`,
  );
}

function writeFakeCurrentOpenshell(fakeBin: string): void {
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash
# request-body-credential-rewrite
# websocket-credential-rewrite
if [ "\${1:-}" = "--version" ]; then
  printf 'openshell ${CURRENT_OPENSHELL_VERSION}\n'
  exit 0
fi
exit 99
# request-body-credential-rewrite websocket-credential-rewrite
`,
  );
}

const runOpenShellGatewayUpgrade = test.skipIf(!shouldRunLiveE2EScenarios());
const runLinuxOpenShellGatewayUpgrade = test.skipIf(
  !shouldRunLiveE2EScenarios() || process.platform !== "linux",
);

runLinuxOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: upgrades old working OpenClaw claw and restores survivor state",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host }) => {
    await artifacts.writeJson("live-upgrade-scenario.json", {
      id: "openshell-gateway-upgrade",
      runner: "vitest",
      boundary: [
        "real old install.sh fetched from v0.0.36",
        "real Docker/OpenShell gateway and OpenClaw sandbox",
        "current scripts/install.sh gateway upgrade path",
        "sandbox exec /proc process probe",
        "NemoClaw registry and durable workspace restore",
      ],
      legacySource: "test/e2e/test-openshell-gateway-upgrade.sh",
      oldNemoclawRef: OLD_NEMOCLAW_REF,
      oldOpenShellVersion: OLD_OPENSHELL_VERSION,
      currentOpenShellVersion: CURRENT_OPENSHELL_VERSION,
      survivorSandbox: SURVIVOR_SANDBOX,
    });

    cleanup.add("remove openshell gateway upgrade survivor sandbox", async () => {
      await bash(
        host,
        `command -v openshell >/dev/null 2>&1 && openshell sandbox delete ${shellQuote(SURVIVOR_SANDBOX)} >/dev/null 2>&1 || true`,
        { artifactName: "cleanup-survivor-sandbox", timeoutMs: 120_000 },
      );
    });
    cleanup.add("remove openshell gateway upgrade gateway", async () => {
      await bash(
        host,
        `command -v openshell >/dev/null 2>&1 && openshell gateway remove nemoclaw >/dev/null 2>&1 || true
rm -f ${shellQuote(PID_FILE)}`,
        { artifactName: "cleanup-gateway", timeoutMs: 120_000 },
      );
    });

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: "dummy",
      model: "test-model",
      responseText: "ok",
    });
    cleanup.add("close compatible endpoint mock", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
      await fake.close();
    });
    await artifacts.writeJson("fake-openai-compatible.json", {
      baseUrl: fake.baseUrl,
    });

    await installOldNemoclawAndClaw(host, artifacts, fake.baseUrl);
    const survivorPid = await startSurvivorAgentInExistingClaw(host);
    expect(Number.isInteger(survivorPid) && survivorPid > 0).toBe(true);
    await installCurrentNemoclawUpgrade(
      host,
      fake.baseUrl,
      artifacts.pathFor("current-install.log"),
    );
    await assertSurvivorSandboxAfterUpgrade(host);
  },
);

runOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: macOS incomplete current install fetches Darwin gateway asset",
  async ({ artifacts }) => {
    const curlLog = artifacts.pathFor("macos-missing-gateway/curl.log");
    const result = runMacInstallerProbe(artifacts, "missing-gateway", (fakeBin) => {
      fs.mkdirSync(path.dirname(curlLog), { recursive: true });
      writeFakeDarwinUname(fakeBin);
      writeFakeCurrentOpenshell(fakeBin);
      writeExecutable(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
printf '%s\n' "$*" >>${shellQuote(curlLog)}
if [ -n "$out" ]; then
  printf 'fake payload\n' >"$out"
fi
exit 0
`,
      );
      return { NEMOCLAW_FAKE_CURL_LOG: curlLog };
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, output).not.toBe(0);
    expect(result.stdout).toContain("missing Docker-driver binaries");
    const downloads = fs.readFileSync(curlLog, "utf8");
    expect(downloads).toContain("openshell-gateway-aarch64-apple-darwin.tar.gz");
    expect(downloads).not.toContain("openshell-driver-vm-aarch64-apple-darwin.tar.gz");
  },
);

runOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: macOS installer does not require VM driver Hypervisor entitlement",
  async ({ artifacts }) => {
    const signLog = artifacts.pathFor("macos-vm-driver-entitlement/codesign.log");
    const stateFile = artifacts.pathFor("macos-vm-driver-entitlement/codesign-state");
    const result = runMacInstallerProbe(artifacts, "vm-driver-entitlement", (fakeBin) => {
      fs.mkdirSync(path.dirname(signLog), { recursive: true });
      writeFakeDarwinUname(fakeBin);
      writeFakeCurrentOpenshell(fakeBin);
      writeExecutable(path.join(fakeBin, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(path.join(fakeBin, "openshell-driver-vm"), "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(
        path.join(fakeBin, "codesign"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-d" ]; then
  if [ -f ${shellQuote(stateFile)} ]; then
    printf '%s\n' '<plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>'
  fi
  exit 0
fi
printf '%s\n' "$*" >>${shellQuote(signLog)}
: >${shellQuote(stateFile)}
exit 0
`,
      );
      return {
        NEMOCLAW_FAKE_CODESIGN_LOG: signLog,
        NEMOCLAW_FAKE_CODESIGN_STATE: stateFile,
      };
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, output).toBe(0);
    const signLogText = fs.existsSync(signLog) ? fs.readFileSync(signLog, "utf8") : "";
    expect(signLogText).not.toContain("--force --sign - --entitlements");
    expect(result.stdout).not.toContain("Installing OpenShell from release");
  },
);

runOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: macOS Docker sandbox builds keep VM rootfs compatibility disabled",
  async ({ artifacts }) => {
    await artifacts.writeJson("macos-docker-rootfs-permissions-scenario.json", {
      id: "openshell-gateway-upgrade-macos-docker-rootfs-permissions",
      runner: "vitest",
      boundary: "static Dockerfile and Dockerfile patch contract",
      legacySource: "test/e2e/test-openshell-gateway-upgrade.sh",
    });
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    const patchFlow = fs.readFileSync(
      path.join(REPO_ROOT, "src/lib/onboard/sandbox-dockerfile-patch-flow.ts"),
      "utf8",
    );
    const dockerfilePatch = fs.readFileSync(
      path.join(REPO_ROOT, "src/lib/onboard/dockerfile-patch.ts"),
      "utf8",
    );
    const hermesDockerfile = fs.readFileSync(
      path.join(REPO_ROOT, "agents/hermes/Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("ARG NEMOCLAW_DARWIN_VM_COMPAT=0");
    expect(dockerfilePatch).toContain(
      'ARG NEMOCLAW_DARWIN_VM_COMPAT=${sanitizeDockerArg(darwinVmCompat ? "1" : "0")}',
    );
    expect(patchFlow).toContain("const darwinVmCompat = false;");
    expect(dockerfile).toContain("chmod -R a+rwX /sandbox/.openclaw");
    expect(hermesDockerfile).toContain("ARG NEMOCLAW_DARWIN_VM_COMPAT=0");
    expect(hermesDockerfile).toContain("chmod -R a+rwX /sandbox/.hermes");
    expect(hermesDockerfile).toContain("chmod a+rw /sandbox/.bashrc /sandbox/.profile");
  },
);
