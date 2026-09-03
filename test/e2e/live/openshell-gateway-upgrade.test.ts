// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs one reviewed historical NemoClaw/OpenShell gateway, creates a real
 * OpenClaw sandbox, seeds durable workspace state, and runs the current
 * installer upgrade path. The survivor must remain usable and retain its
 * workspace state across the gateway transition.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packReviewedNpmArchive,
  removeReviewedNpmArchive,
} from "../../../scripts/lib/reviewed-npm-archive.mts";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { type ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  type FakeOpenAiCompatibleServer,
  startFakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";
import { registerOpenShellHostMockFirewall } from "../fixtures/host-mock-firewall.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  currentGatewayUpgradeInstallerArgs,
  currentNemoclawUpgradeRef,
  GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  legacyGatewayUpgradeHostFirewallOptions,
  oldGatewayUpgradeInstallerArgs,
  throwGatewayUpgradeSetupFailures,
  upgradeGatewayCleanupScript,
  upgradeGatewayStateCleanupScript,
  validateLegacyGatewayUpgradeFixture,
} from "./openshell-gateway-upgrade-helpers.ts";
import {
  patchOldInstallerFixture,
  reviewedOldOpenClawArchive,
} from "./openshell-gateway-upgrade-old-installer.ts";

const STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
);
const PID_FILE = path.join(STATE_DIR, "openshell-gateway.pid");
const OLD_NEMOCLAW_REF = process.env.NEMOCLAW_OLD_NEMOCLAW_REF ?? "v0.0.89";
const OLD_NEMOCLAW_COMMIT =
  process.env.NEMOCLAW_OLD_NEMOCLAW_COMMIT ?? "1143aa5cce77f3bad1b3b5588bd7fddbe438237e";
const OLD_INSTALLER_SHA256 =
  process.env.NEMOCLAW_OLD_INSTALLER_SHA256 ??
  "00f24959e5ca68104fe91221c0a015dab6a4154618497fa36b969b661f418cc2";
const OLD_OPENSHELL_VERSION = process.env.NEMOCLAW_OLD_OPENSHELL_VERSION ?? "0.0.85";
const CURRENT_OPENSHELL_VERSION = process.env.NEMOCLAW_CURRENT_OPENSHELL_VERSION ?? "0.0.106";
const OLD_SANDBOX_BASE_IMAGE_REF =
  process.env.NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF ??
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1";
const OLD_OPENCLAW_VERSION = process.env.NEMOCLAW_OLD_OPENCLAW_VERSION ?? "2026.6.10";
const OLD_INSTALLER_FIXTURE_IDENTITY = Object.freeze({
  nemoclawCommit: OLD_NEMOCLAW_COMMIT,
  nemoclawRef: OLD_NEMOCLAW_REF,
  openclawVersion: OLD_OPENCLAW_VERSION,
});
validateLegacyGatewayUpgradeFixture({
  ...OLD_INSTALLER_FIXTURE_IDENTITY,
  installerSha256: OLD_INSTALLER_SHA256,
  sandboxBaseImageRef: OLD_SANDBOX_BASE_IMAGE_REF,
});
const SURVIVOR_SANDBOX =
  process.env.NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME ?? `e2e-gw-${process.pid}`;
const SURVIVOR_MARKER = `gateway-upgrade-survivor-${Date.now()}`;
const SURVIVOR_MARKER_PATH = "/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-marker";
const TEST_TIMEOUT_MS = 65 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;

validateSandboxName(SURVIVOR_SANDBOX);
expect(
  SURVIVOR_SANDBOX.startsWith("e2e-gw-"),
  `openshell-gateway-upgrade live test only accepts survivor sandbox names with prefix e2e-gw-; got ${SURVIVOR_SANDBOX}`,
).toBe(true);
expect(SURVIVOR_SANDBOX.length).toBeLessThanOrEqual(19);

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

function withoutEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !excluded.has(key)));
}

function shellLoginPrefix(): string {
  const lines = [
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
  ];
  lines.push('export PATH="$HOME/.local/bin:$PATH"');
  return lines.join("\n");
}

function expectOutputContains(result: ShellProbeResult, value: string, label: string): void {
  expect(resultText(result), label).toContain(value);
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

async function runInSurvivorSandbox(
  host: HostCliClient,
  command: string,
  options: { artifactName: string; currentCli?: boolean; timeoutMs?: number },
): Promise<ShellProbeResult> {
  const prefix = options.currentCli
    ? `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} exec --`
    : `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} --`;
  return bash(host, `${prefix} sh -lc ${shellQuote(command)}`, {
    artifactName: options.artifactName,
    redactionValues: ["dummy"],
    timeoutMs: options.timeoutMs ?? 60_000,
  });
}

async function assertOpenClawAgentSecretBoundary(
  host: HostCliClient,
  fake: FakeOpenAiCompatibleServer,
  phase: "legacy" | "upgraded",
): Promise<void> {
  const secretNonExposure = await runInSurvivorSandbox(
    host,
    `node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const gatewayCredential = String.fromCharCode(100, 117, 109, 109, 121);
if (Object.values(process.env).some((value) => value === gatewayCredential)) {
  process.exit(41);
}

const managedFiles = ["/sandbox/.openclaw/openclaw.json"];
const agentsRoot = "/sandbox/.openclaw/agents";
if (fs.existsSync(agentsRoot)) {
  const pending = [agentsRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name === "auth-profiles.json") managedFiles.push(entryPath);
    }
  }
}

if (
  managedFiles.some(
    (file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(gatewayCredential),
  )
) {
  process.exit(42);
}
NODE`,
    {
      artifactName: `state-upgrade-${phase}-secret-non-exposure`,
      currentCli: phase === "upgraded",
    },
  );
  expectExitZero(
    secretNonExposure,
    `${phase} gateway credential must not be projected into sandbox environment or managed OpenClaw files`,
  );

  const requestOffset = fake.requests().length;
  const agent = await runInSurvivorSandbox(
    host,
    `openclaw agent --agent main --json --thinking off --session-id ${shellQuote(
      `e2e-state-upgrade-${phase}`,
    )} -m ${shellQuote("Reply with only: ok")}`,
    {
      artifactName: `state-upgrade-${phase}-agent`,
      currentCli: phase === "upgraded",
      timeoutMs: 120_000,
    },
  );
  expectExitZero(agent, `${phase} sandbox-user OpenClaw agent turn`);
  expect(parseOpenClawAgentText(agent.stdout).toLowerCase()).toContain("ok");
  const requests = fake
    .requests()
    .slice(requestOffset)
    .filter((request) => request.path.includes("/chat/completions"));
  expect(requests.length, `${phase} agent turn must reach the compatible endpoint`).toBeGreaterThan(
    0,
  );
  // The fake endpoint deliberately records only the validated auth result, not
  // the bearer value. With requireAuth enabled, "ok" means the request carried
  // the exact gateway-held `dummy` credential; `unused`, a placeholder, or a
  // missing header would receive 401 and could not complete this agent turn.
  expect(
    requests.every((request) => request.auth === "ok" && request.authorizationSent === true),
  ).toBe(true);
}

function createOldDockerWrapper(artifacts: ArtifactSink): string {
  const wrapperDir = artifacts.pathFor("old-docker-wrapper");
  const logFile = artifacts.pathFor("old-docker-wrapper.log");
  const realDocker = process.env.NEMOCLAW_REAL_DOCKER ?? "/usr/bin/docker";
  fs.mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
  writeExecutable(
    path.join(wrapperDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
real_docker=${shellQuote(realDocker)}
base_ref=${shellQuote(OLD_SANDBOX_BASE_IMAGE_REF)}
old_openclaw=${shellQuote(OLD_OPENCLAW_VERSION)}
log_file=${shellQuote(logFile)}
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

async function runInstallerPayload(
  host: HostCliClient,
  label: string,
  installerArgs: readonly string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
  redactionValues: string[] = [],
): Promise<ShellProbeResult> {
  const quotedInstallerArgs = installerArgs.map(shellQuote).join(" ");
  const installerCommand = `bash ${quotedInstallerArgs} >${shellQuote(logFile)} 2>&1`;
  const result = await bash(
    host,
    `rm -f ${shellQuote(logFile)}
${installerCommand}`,
    {
      artifactName: `${label.replace(/[^a-z0-9_.-]+/gi, "-")}-installer`,
      env,
      redactionValues,
      timeoutMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
    },
  );
  const tail = await bash(host, `tail -160 ${shellQuote(logFile)} 2>/dev/null || true`, {
    artifactName: `${label}-installer-tail`,
    timeoutMs: 30_000,
  });
  expect(
    result.exitCode,
    `${label} NemoClaw installer returned an unexpected exit code:\n${resultText(tail)}`,
  ).toBe(0);
  return result;
}

async function preCleanUpgradeGateway(host: HostCliClient, artifactName: string): Promise<void> {
  const result = await bash(host, upgradeGatewayCleanupScript(PID_FILE), {
    artifactName,
    timeoutMs: 120_000,
  });
  expectExitZero(result, "pre-clean OpenShell gateway upgrade state");
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
    `curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/${shellQuote(OLD_NEMOCLAW_COMMIT)}/install.sh -o ${shellQuote(oldInstaller)}`,
    { artifactName: "download-old-installer", timeoutMs: 90_000 },
  );
  expectExitZero(download, `download old ${OLD_NEMOCLAW_REF} installer`);
  const downloadedInstallerSha256 = createHash("sha256")
    .update(fs.readFileSync(oldInstaller))
    .digest("hex");
  expect(
    downloadedInstallerSha256,
    `downloaded ${OLD_NEMOCLAW_REF} installer must match its pinned SHA-256`,
  ).toBe(OLD_INSTALLER_SHA256);
  fs.chmodSync(oldInstaller, 0o755);
  patchOldInstallerFixture(oldInstaller, OLD_INSTALLER_FIXTURE_IDENTITY);

  const reviewedOpenClaw = packReviewedNpmArchive(reviewedOldOpenClawArchive(OLD_OPENCLAW_VERSION));

  const installEnv = liveEnv({
    // The historical bootstrap owns its pinned source Dockerfile. An explicit
    // empty value prevents the surrounding candidate local-Dockerfile plan
    // from replacing that fixture at the ShellProbe boundary.
    E2E_WORKLOAD_SOURCE: "",
    PATH: `${wrapperDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_REAL_DOCKER: process.env.NEMOCLAW_REAL_DOCKER ?? "/usr/bin/docker",
    NEMOCLAW_SANDBOX_BASE_IMAGE_REF: OLD_SANDBOX_BASE_IMAGE_REF,
    NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF: OLD_SANDBOX_BASE_IMAGE_REF,
    NEMOCLAW_OLD_OPENCLAW_ARCHIVE: reviewedOpenClaw.archivePath,
    NEMOCLAW_OLD_OPENCLAW_VERSION: OLD_OPENCLAW_VERSION,
    NEMOCLAW_OLD_DOCKER_WRAPPER_LOG: oldDockerLog,
    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
    NEMOCLAW_INSTALL_REF: OLD_NEMOCLAW_COMMIT,
    NEMOCLAW_INSTALL_TAG: OLD_NEMOCLAW_COMMIT,
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: SURVIVOR_SANDBOX,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
  });

  // A transient gateway import failure leaves the old installer session in a
  // failed state. Keep Vitest retries independent without applying --fresh to
  // the later current-version upgrade, which must preserve the survivor.
  try {
    await runInstallerPayload(
      host,
      `old-${OLD_NEMOCLAW_REF}`,
      oldGatewayUpgradeInstallerArgs(oldInstaller),
      oldInstallLog,
      installEnv,
    );
  } finally {
    removeReviewedNpmArchive(reviewedOpenClaw);
  }
  await artifacts.writeText(
    "old-docker-wrapper.log",
    fs.existsSync(oldDockerLog) ? fs.readFileSync(oldDockerLog, "utf8") : "",
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

  await waitForSurvivorReady(host, "old-install");
  const list = await bash(host, `nemoclaw list`, {
    artifactName: "old-nemoclaw-list",
    timeoutMs: 60_000,
  });
  expectExitZero(list, "old nemoclaw list");
  expectOutputContains(list, SURVIVOR_SANDBOX, "old NemoClaw install must register survivor claw");
}

async function writeSurvivorMarker(host: HostCliClient): Promise<void> {
  const markerResult = await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc ${shellQuote(`mkdir -p /sandbox/.openclaw/workspace && printf '%s\\n' ${shellQuote(SURVIVOR_MARKER)} >${shellQuote(SURVIVOR_MARKER_PATH)}`)}`,
    { artifactName: "write-survivor-marker", timeoutMs: 60_000 },
  );
  expectExitZero(markerResult, "write survivor marker before gateway upgrade");
}

async function installCurrentNemoclawUpgrade(
  host: HostCliClient,
  fakeBaseUrl: string,
  currentInstallLog: string,
): Promise<void> {
  const currentRef = currentNemoclawUpgradeRef(process.env);
  const currentEnv = withoutEnvKeys(
    liveEnv({
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
      NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
      NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: JSON.stringify([SURVIVOR_SANDBOX]),
      NEMOCLAW_INSTALL_REF: currentRef,
      NEMOCLAW_INSTALL_TAG: currentRef,
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
      NEMOCLAW_MODEL: "test-model",
      NEMOCLAW_SANDBOX_NAME: SURVIVOR_SANDBOX,
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_DASHBOARD_PORT: "",
      CHAT_UI_URL: "",
    }),
    ["COMPATIBLE_API_KEY"],
  );
  const redactionValues = [process.env.GITHUB_TOKEN ?? ""].filter(Boolean);
  await runInstallerPayload(
    host,
    `current-${currentRef.slice(0, 12)}`,
    currentGatewayUpgradeInstallerArgs(path.join(REPO_ROOT, "scripts", "install.sh")),
    currentInstallLog,
    currentEnv,
    redactionValues,
  );

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
}

async function assertSurvivorSandboxAfterUpgrade(host: HostCliClient): Promise<void> {
  await waitForSurvivorReady(host, "post-upgrade");

  const marker = await bash(
    host,
    `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} exec -- cat ${shellQuote(SURVIVOR_MARKER_PATH)}`,
    { artifactName: "post-upgrade-survivor-marker", timeoutMs: 60_000 },
  );
  expectExitZero(marker, "read survivor marker after gateway upgrade");
  expect(marker.stdout.trim()).toBe(SURVIVOR_MARKER);

  const agentCheck = await bash(
    host,
    `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} exec -- sh -lc ${shellQuote("command -v openclaw >/dev/null && test -s /sandbox/.openclaw/openclaw.json && openclaw --version 2>/dev/null")}`,
    { artifactName: "post-upgrade-openclaw-agent", timeoutMs: 60_000 },
  );
  expectExitZero(
    agentCheck,
    "OpenClaw agent must remain installed/configured after gateway upgrade",
  );
  expect(agentCheck.stdout.trim().length).toBeGreaterThan(0);

  const list = await bash(host, `nemoclaw list`, {
    artifactName: "post-upgrade-nemoclaw-list",
    timeoutMs: 60_000,
  });
  expectExitZero(list, "nemoclaw list after gateway upgrade");
  expectOutputContains(list, SURVIVOR_SANDBOX, "nemoclaw list must still show survivor sandbox");
}

const runLinuxOpenShellGatewayUpgrade = test.skipIf(process.platform !== "linux");

runLinuxOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: preserves a usable sandbox and workspace state (#10517)",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "clear the prior gateway and start compatible inference",
        "install pinned legacy NemoClaw and its sandbox",
        "verify the legacy agent and write workspace state",
        "upgrade to the current OpenShell gateway",
        "verify the upgraded agent and preserved workspace state",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.writeJson("live-upgrade-target.json", {
      id: "openshell-gateway-upgrade",
      runner: "vitest",
      boundary: [
        `real old install.sh fetched from ${OLD_NEMOCLAW_REF}`,
        "real Docker/OpenShell gateway and OpenClaw sandbox",
        "exact-name confirmation for the known-managed legacy fixture",
        "current scripts/install.sh gateway upgrade path",
        "authenticated OpenClaw turns before and after upgrade",
        "raw gateway credential absent from sandbox environment and managed OpenClaw files",
        "durable workspace restore and survivor discovery through the current CLI",
      ],
      oldNemoclawRef: OLD_NEMOCLAW_REF,
      oldNemoclawCommit: OLD_NEMOCLAW_COMMIT,
      oldInstallerSha256: OLD_INSTALLER_SHA256,
      oldOpenShellVersion: OLD_OPENSHELL_VERSION,
      oldOpenClawVersion: OLD_OPENCLAW_VERSION,
      oldSandboxBaseImageRef: OLD_SANDBOX_BASE_IMAGE_REF,
      currentOpenShellVersion: CURRENT_OPENSHELL_VERSION,
      survivorSandbox: SURVIVOR_SANDBOX,
    });

    cleanup.trackDisposable("remove openshell gateway upgrade state", async () => {
      const result = await bash(host, upgradeGatewayStateCleanupScript(PID_FILE), {
        artifactName: "cleanup-gateway-state",
        timeoutMs: 120_000,
      });
      expectExitZero(result, "cleanup OpenShell gateway upgrade state");
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-gateway",
      env: liveEnv(),
      timeoutMs: 120_000,
    });
    cleanup.trackDisposable("remove openshell gateway upgrade survivor sandbox", () =>
      sandbox.cleanupSandbox(SURVIVOR_SANDBOX, {
        artifactName: "cleanup-survivor-sandbox",
        env: liveEnv(),
        timeoutMs: 120_000,
      }),
    );

    // Vitest retries execute in the same runner process. Tear down any failed
    // legacy gateway before each attempt so partial containerd layers from a
    // transient image-import failure cannot consume the next attempt's disk.
    await preCleanUpgradeGateway(host, "pre-cleanup-gateway");

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: "dummy",
      host: "0.0.0.0",
      model: "test-model",
      progress,
      publicHost: "host.openshell.internal",
      requireAuth: true,
      requireAuthModels: true,
      responseText: "ok",
    });
    let firewallSetup: ReturnType<typeof registerOpenShellHostMockFirewall>;
    try {
      firewallSetup = registerOpenShellHostMockFirewall({
        cleanup,
        host,
        port: Number(new URL(fake.baseUrl).port),
        ...legacyGatewayUpgradeHostFirewallOptions(),
      });
    } catch (error) {
      await fake.close();
      throw error;
    }
    cleanup.add("close compatible endpoint mock", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
      await fake.close();
    });
    await artifacts.writeJson("fake-openai-compatible.json", {
      baseUrl: fake.baseUrl,
    });

    progress.phase("install pinned legacy NemoClaw and its sandbox");
    const setupResults = await Promise.allSettled([
      installOldNemoclawAndClaw(host, artifacts, fake.baseUrl),
      firewallSetup.then((result) => artifacts.writeJson("host-mock-firewall.json", result)),
    ]);
    throwGatewayUpgradeSetupFailures(setupResults);

    progress.phase("verify the legacy agent and write workspace state");
    await assertOpenClawAgentSecretBoundary(host, fake, "legacy");
    await writeSurvivorMarker(host);

    progress.phase("upgrade to the current OpenShell gateway");
    const currentInstallLog = artifacts.pathFor("current-install.log");
    await installCurrentNemoclawUpgrade(host, fake.baseUrl, currentInstallLog);

    progress.phase("verify the upgraded agent and preserved workspace state");
    await assertSurvivorSandboxAfterUpgrade(host);
    await assertOpenClawAgentSecretBoundary(host, fake, "upgraded");
  },
);
