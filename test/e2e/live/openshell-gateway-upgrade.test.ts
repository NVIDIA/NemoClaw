// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs one reviewed historical NemoClaw/OpenShell gateway, creates a real
 * OpenClaw sandboxes, seeds durable workspace state, and runs the current
 * installer upgrade path. The survivor must remain usable. Fixture-declared
 * stopped sandboxes must preserve their workspace state and stopped phase.
 * Agent-image and OpenClaw-state-format migration are outside this target.
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
import {
  REVIEWED_GATEWAY_UPGRADE_FIXTURE,
  REVIEWED_GATEWAY_UPGRADE_FIXTURES,
} from "../../../tools/e2e/openshell-gateway-upgrade-fixture.mts";
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
  captureGatewayUpgradeFailureDiagnostics,
  currentGatewayUpgradeInstallerArgs,
  currentNemoclawUpgradeRef,
  gatewayCredentialNonExposureScript,
  gatewayUpgradeRecoverySucceeded,
  GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  isolateGatewayUpgradeFixtureEnv,
  legacyGatewayUpgradeBaseImageOverrideEnabled,
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
const OLD_NEMOCLAW_REF =
  process.env.NEMOCLAW_OLD_NEMOCLAW_REF ?? REVIEWED_GATEWAY_UPGRADE_FIXTURE.nemoclawRef;
const REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF =
  REVIEWED_GATEWAY_UPGRADE_FIXTURES.find(
    (candidate) => candidate.nemoclawRef === OLD_NEMOCLAW_REF,
  ) ?? REVIEWED_GATEWAY_UPGRADE_FIXTURE;
const OLD_NEMOCLAW_COMMIT =
  process.env.NEMOCLAW_OLD_NEMOCLAW_COMMIT ??
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.nemoclawCommit;
const OLD_INSTALLER_SHA256 =
  process.env.NEMOCLAW_OLD_INSTALLER_SHA256 ??
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.installerSha256;
const OLD_OPENSHELL_VERSION =
  process.env.NEMOCLAW_OLD_OPENSHELL_VERSION ??
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.openShellVersion;
const CURRENT_OPENSHELL_VERSION = process.env.NEMOCLAW_CURRENT_OPENSHELL_VERSION ?? "0.0.116";
const OLD_SANDBOX_BASE_IMAGE_REF =
  process.env.NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF ??
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.sandboxBaseImageRef;
const OLD_OPENCLAW_VERSION =
  process.env.NEMOCLAW_OLD_OPENCLAW_VERSION ??
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.openclawVersion;
const OLD_INSTALLER_FIXTURE_IDENTITY = Object.freeze({
  nemoclawCommit: OLD_NEMOCLAW_COMMIT,
  nemoclawRef: OLD_NEMOCLAW_REF,
  openclawVersion: OLD_OPENCLAW_VERSION,
});
validateLegacyGatewayUpgradeFixture({
  ...OLD_INSTALLER_FIXTURE_IDENTITY,
  installerSha256: OLD_INSTALLER_SHA256,
  openShellVersion: OLD_OPENSHELL_VERSION,
  sandboxBaseImageRef: OLD_SANDBOX_BASE_IMAGE_REF,
});
const SURVIVOR_SANDBOX =
  process.env.NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME ?? `e2e-gw-${process.pid}`;
const ADDITIONAL_STOPPED_SANDBOXES = Array.from(
  { length: REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.additionalStoppedSandboxes },
  (_, index) => `e2e-gw-${process.pid}-${index + 1}`,
);
const LEGACY_SANDBOXES = Object.freeze([SURVIVOR_SANDBOX, ...ADDITIONAL_STOPPED_SANDBOXES]);
const SURVIVOR_MARKER = `gateway-upgrade-survivor-${Date.now()}`;
const SURVIVOR_MARKER_PATH = "/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-marker";
const STOPPED_SANDBOX_MARKER_PATH =
  "/sandbox/.openclaw/workspace/nemoclaw-gateway-upgrade-stopped-marker";
const DASHBOARD_PORT = "18789";
const GATEWAY_CREDENTIAL = "nemoclaw-gateway-upgrade-fixture-key";
const TEST_TIMEOUT_MS =
  REVIEWED_GATEWAY_UPGRADE_FIXTURE_FOR_REF.additionalStoppedSandboxes > 0
    ? 110 * 60_000
    : 65 * 60_000;
const OPENSHELL_TIMEOUT_MS = 2 * 60_000;

validateSandboxName(SURVIVOR_SANDBOX);
expect(
  SURVIVOR_SANDBOX.startsWith("e2e-gw-"),
  `openshell-gateway-upgrade live test only accepts survivor sandbox names with prefix e2e-gw-; got ${SURVIVOR_SANDBOX}`,
).toBe(true);
expect(SURVIVOR_SANDBOX.length).toBeLessThanOrEqual(19);
for (const sandboxName of ADDITIONAL_STOPPED_SANDBOXES) {
  validateSandboxName(sandboxName);
}

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

async function bash(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    captureLimitBytes?: number;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    cwd?: string;
    redactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", `${shellLoginPrefix()}\n${script}`], {
    cwd: options.cwd ?? REPO_ROOT,
    artifactName: options.artifactName,
    captureLimitBytes: options.captureLimitBytes,
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
    redactionValues: [GATEWAY_CREDENTIAL],
    timeoutMs: options.timeoutMs ?? 60_000,
  });
}

type CredentialBoundaryEvidence = {
  readonly diagnostic: string;
  readonly valid: boolean;
};

async function collectOpenClawCredentialBoundary(
  host: HostCliClient,
  fake: FakeOpenAiCompatibleServer,
  phase: "legacy" | "upgraded",
): Promise<CredentialBoundaryEvidence> {
  const secretNonExposure = await runInSurvivorSandbox(
    host,
    gatewayCredentialNonExposureScript(GATEWAY_CREDENTIAL),
    {
      artifactName: `state-upgrade-${phase}-secret-non-exposure`,
      currentCli: phase === "upgraded",
    },
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
  const requests = fake
    .requests()
    .slice(requestOffset)
    .filter((request) => request.path.includes("/chat/completions"));
  // The fake records only whether authentication succeeded. A missing,
  // placeholder, or incorrect credential receives 401 and cannot complete.
  return {
    diagnostic: `${phase} credential scan:\n${resultText(secretNonExposure)}\n${phase} agent turn:\n${resultText(agent)}\n${phase} compatible requests:\n${JSON.stringify(requests, null, 2)}`,
    valid:
      secretNonExposure.exitCode === 0 &&
      agent.exitCode === 0 &&
      parseOpenClawAgentText(agent.stdout).trim().toLowerCase() === "ok" &&
      requests.length > 0 &&
      requests.every((request) => request.auth === "ok" && request.authorizationSent === true),
  };
}

function createOldDockerWrapper(artifacts: ArtifactSink): string {
  const wrapperDir = artifacts.pathFor("old-docker-wrapper");
  const logFile = artifacts.pathFor("old-docker-wrapper.log");
  const realDocker = process.env.NEMOCLAW_REAL_DOCKER ?? "/usr/bin/docker";
  const rewriteBaseImage = legacyGatewayUpgradeBaseImageOverrideEnabled(OLD_SANDBOX_BASE_IMAGE_REF);
  const inlineBaseImageHandler = rewriteBaseImage
    ? `      args+=("--build-arg=BASE_IMAGE=\${base_ref}")
      rewrote_base=1
      printf 'rewrite build-arg %s -> BASE_IMAGE=%s\\n' "$1" "$base_ref" >>"$log_file"`
    : `      args+=("$1")`;
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
if [ -n "$base_ref" ] && [ "\${1:-}" = "pull" ]; then
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
      if [ -n "$base_ref" ] && [ "$#" -ge 2 ] && [ "\${2#BASE_IMAGE=}" != "$2" ]; then
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
${inlineBaseImageHandler}
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
if [ -n "$base_ref" ] && [ "$rewrote_base" = "0" ]; then
  args+=("--build-arg" "BASE_IMAGE=\${base_ref}")
  printf 'add build-arg BASE_IMAGE=%s\n' "$base_ref" >>"$log_file"
fi
exec "$real_docker" "\${args[@]}"
`,
  );
  return wrapperDir;
}

async function waitForSandboxPhase(
  host: HostCliClient,
  sandboxName: string,
  phase: "Ready" | "Stopped",
  labelPrefix: string,
): Promise<void> {
  let attempt = 0;
  let matched = false;
  while (attempt < 60 && !matched) {
    const result = await bash(host, `openshell sandbox list 2>/dev/null || true`, {
      artifactName: `${labelPrefix}-sandbox-list-${attempt}`,
      timeoutMs: 30_000,
    });
    matched = resultText(result)
      .split(/\r?\n/u)
      .some((line) => line.includes(sandboxName) && line.includes(phase));
    attempt += 1;
    matched || (await new Promise<void>((resolve) => setTimeout(resolve, 2_000)));
  }
  expect(matched, `sandbox ${sandboxName} did not become ${phase}`).toBe(true);
}

async function runInstallerPayload(
  host: HostCliClient,
  label: string,
  installerArgs: readonly string[],
  artifacts: ArtifactSink,
  logName: string,
  env: NodeJS.ProcessEnv,
  options: {
    onFailure?: () => Promise<void>;
    redactionValues?: string[];
  } = {},
): Promise<ShellProbeResult> {
  const redactionValues = options.redactionValues ?? [];
  const quotedInstallerArgs = installerArgs.map(shellQuote).join(" ");
  const result = await bash(host, `bash ${quotedInstallerArgs}`, {
    artifactName: `${label.replace(/[^a-z0-9_.-]+/gi, "-")}-installer`,
    captureLimitBytes: 1024 * 1024,
    env,
    redactionValues,
    timeoutMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  });
  artifacts.addRedactionValues(redactionValues);
  await artifacts.writeText(logName, resultText(result));
  await captureGatewayUpgradeFailureDiagnostics(result.exitCode, options.onFailure);
  expect(result.exitCode === 0, `${label} NemoClaw installer failed:\n${resultText(result)}`).toBe(
    true,
  );
  return result;
}

async function createStoppedLegacySandboxes(
  host: HostCliClient,
  fakeBaseUrl: string,
): Promise<void> {
  for (const sandboxName of ADDITIONAL_STOPPED_SANDBOXES) {
    const onboardEnv = isolateGatewayUpgradeFixtureEnv(
      liveEnv({
        COMPATIBLE_API_KEY: GATEWAY_CREDENTIAL,
        NEMOCLAW_DASHBOARD_PORT: "",
        NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
        NEMOCLAW_MODEL: "test-model",
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_SANDBOX_NAME: sandboxName,
      }),
      "",
    );
    const onboard = await bash(host, "nemoclaw onboard --non-interactive", {
      artifactName: `old-onboard-${sandboxName}`,
      env: onboardEnv,
      redactionValues: [GATEWAY_CREDENTIAL],
      timeoutMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
    });
    expectExitZero(onboard, `onboard stopped sandbox ${sandboxName}`);
    await waitForSandboxPhase(host, sandboxName, "Ready", `old-${sandboxName}`);

    const marker = `gateway-upgrade-stopped-${sandboxName}`;
    const markerWrite = await bash(
      host,
      `openshell sandbox exec --name ${shellQuote(sandboxName)} -- sh -lc ${shellQuote(`mkdir -p /sandbox/.openclaw/workspace && printf '%s\n' ${shellQuote(marker)} >${shellQuote(STOPPED_SANDBOX_MARKER_PATH)}`)}`,
      {
        artifactName: `old-marker-${sandboxName}`,
        env: onboardEnv,
        redactionValues: [GATEWAY_CREDENTIAL],
        timeoutMs: 60_000,
      },
    );
    expectExitZero(markerWrite, `write stopped sandbox marker for ${sandboxName}`);

    await bash(host, `openshell sandbox stop -g nemoclaw ${shellQuote(sandboxName)}`, {
      artifactName: `old-stop-${sandboxName}`,
      env: onboardEnv,
      redactionValues: [GATEWAY_CREDENTIAL],
      timeoutMs: 120_000,
    });
    await waitForSandboxPhase(host, sandboxName, "Stopped", `old-${sandboxName}`);
  }
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

  // The historical bootstrap owns its pinned source Dockerfile. Isolate it
  // from both candidate local-Dockerfile selection and managed-image catalogs.
  const installEnv = isolateGatewayUpgradeFixtureEnv(
    liveEnv({
      PATH: `${wrapperDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      COMPATIBLE_API_KEY: GATEWAY_CREDENTIAL,
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
    }),
    "",
  );

  // A transient gateway import failure leaves the old installer session in a
  // failed state. Keep Vitest retries independent without applying --fresh to
  // the later current-version upgrade, which must preserve the survivor.
  try {
    await runInstallerPayload(
      host,
      `old-${OLD_NEMOCLAW_REF}`,
      oldGatewayUpgradeInstallerArgs(oldInstaller),
      artifacts,
      "old-install.log",
      installEnv,
      { redactionValues: [GATEWAY_CREDENTIAL] },
    );
  } finally {
    removeReviewedNpmArchive(reviewedOpenClaw);
  }
  await artifacts.writeText(
    "old-docker-wrapper.log",
    fs.existsSync(oldDockerLog) ? fs.readFileSync(oldDockerLog, "utf8") : "",
  );

  const openshellVersion = await bash(
    host,
    `openshell --version | grep -F -- ${shellQuote(OLD_OPENSHELL_VERSION)}`,
    {
      artifactName: "old-openshell-version",
      timeoutMs: 30_000,
    },
  );
  expectExitZero(openshellVersion, "old openshell --version");
}

async function writeSurvivorMarker(host: HostCliClient): Promise<void> {
  await bash(
    host,
    `openshell sandbox exec --name ${shellQuote(SURVIVOR_SANDBOX)} -- sh -lc ${shellQuote(`mkdir -p /sandbox/.openclaw/workspace && printf '%s\\n' ${shellQuote(SURVIVOR_MARKER)} >${shellQuote(SURVIVOR_MARKER_PATH)}`)}`,
    { artifactName: "write-survivor-marker", timeoutMs: 60_000 },
  );
}

async function installCurrentNemoclawUpgrade(
  host: HostCliClient,
  artifacts: ArtifactSink,
  fakeBaseUrl: string,
): Promise<void> {
  const currentRef = currentNemoclawUpgradeRef(process.env);
  const currentBaseEnv = liveEnv({
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
    NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: JSON.stringify(LEGACY_SANDBOXES),
    NEMOCLAW_INSTALL_REF: currentRef,
    NEMOCLAW_INSTALL_TAG: currentRef,
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: SURVIVOR_SANDBOX,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
  });
  const currentEnv = withoutEnvKeys(
    legacyGatewayUpgradeBaseImageOverrideEnabled(OLD_SANDBOX_BASE_IMAGE_REF)
      ? isolateGatewayUpgradeFixtureEnv(currentBaseEnv, "local-dockerfile")
      : currentBaseEnv,
    ["COMPATIBLE_API_KEY"],
  );
  const redactionValues = [GATEWAY_CREDENTIAL, process.env.GITHUB_TOKEN ?? ""].filter(Boolean);
  await runInstallerPayload(
    host,
    `current-${currentRef.slice(0, 12)}`,
    currentGatewayUpgradeInstallerArgs(path.join(REPO_ROOT, "scripts", "install.sh")),
    artifacts,
    "current-install.log",
    currentEnv,
    {
      onFailure: async () => {
        await Promise.allSettled([
          bash(host, `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} doctor`, {
            artifactName: "current-install-failure-doctor",
            env: currentEnv,
            redactionValues,
            timeoutMs: 120_000,
          }),
          bash(
            host,
            `container_id="$(docker ps -aq --filter ${shellQuote(`label=openshell.ai/sandbox-name=${SURVIVOR_SANDBOX}`)} | head -n 1)"
start_log="$(mktemp)"
trap 'rm -f -- "$start_log"' EXIT
docker cp "$container_id:/tmp/nemoclaw-start.log" "$start_log"
tail -n 500 "$start_log"`,
            {
              artifactName: "current-install-failure-start-log",
              env: currentEnv,
              redactionValues,
              timeoutMs: 30_000,
            },
          ),
        ]);
      },
      redactionValues,
    },
  );
  const openshellVersion = await bash(
    host,
    `openshell --version | grep -F -- ${shellQuote(CURRENT_OPENSHELL_VERSION)}`,
    {
      artifactName: "current-openshell-version",
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(openshellVersion, "current openshell --version");
}

async function assertSurvivorSandboxAfterUpgrade(host: HostCliClient): Promise<void> {
  await waitForSandboxPhase(host, SURVIVOR_SANDBOX, "Ready", "post-upgrade");

  const stateChecks = [
    await bash(
      host,
      `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} exec -- grep -Fx -- ${shellQuote(SURVIVOR_MARKER)} ${shellQuote(SURVIVOR_MARKER_PATH)}`,
      { artifactName: "post-upgrade-survivor-marker", timeoutMs: 60_000 },
    ),
  ];

  for (const sandboxName of ADDITIONAL_STOPPED_SANDBOXES) {
    await waitForSandboxPhase(host, sandboxName, "Stopped", `post-upgrade-${sandboxName}`);
    await bash(host, `openshell sandbox start -g nemoclaw ${shellQuote(sandboxName)}`, {
      artifactName: `post-upgrade-start-${sandboxName}`,
      timeoutMs: 120_000,
    });
    await waitForSandboxPhase(host, sandboxName, "Ready", `post-upgrade-${sandboxName}`);

    const marker = `gateway-upgrade-stopped-${sandboxName}`;
    stateChecks.push(
      await bash(
        host,
        `nemoclaw ${shellQuote(sandboxName)} exec -- grep -Fx -- ${shellQuote(marker)} ${shellQuote(STOPPED_SANDBOX_MARKER_PATH)}`,
        { artifactName: `post-upgrade-marker-${sandboxName}`, timeoutMs: 60_000 },
      ),
    );
    await bash(host, `openshell sandbox stop -g nemoclaw ${shellQuote(sandboxName)}`, {
      artifactName: `post-upgrade-stop-${sandboxName}`,
      timeoutMs: 120_000,
    });
    await waitForSandboxPhase(host, sandboxName, "Stopped", `post-upgrade-${sandboxName}`);
  }

  const recover = await bash(host, `nemoclaw ${shellQuote(SURVIVOR_SANDBOX)} recover`, {
    artifactName: "post-upgrade-forward-recovery",
  });

  const forward = await host.inspectOpenShellForwardListener(DASHBOARD_PORT, SURVIVOR_SANDBOX, {
    artifactName: "post-upgrade-dashboard-forward",
    env: liveEnv(),
  });
  expect(
    gatewayUpgradeRecoverySucceeded(recover, forward, stateChecks),
    `${stateChecks.map(resultText).join("\n")}\n${resultText(recover)}\n${forward.output}`,
  ).toBe(true);
}

const runOpenShellGatewayUpgrade = test.skipIf(process.platform !== "linux");

runOpenShellGatewayUpgrade(
  "openshell-gateway-upgrade: restores gateway registration and all sandbox state (#11898)",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "clear the prior gateway and start compatible inference",
        "install pinned legacy NemoClaw and its sandbox",
        "create and stop the fixture-declared additional sandboxes",
        "verify legacy credential custody and write durable workspace state",
        "upgrade to the current OpenShell gateway",
        "verify preserved workspace state and every recovered stopped sandbox",
        "verify upgraded credential custody",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.writeJson("live-upgrade-target.json", {
      id: "openshell-gateway-upgrade",
      runner: "vitest",
      boundary: [
        `real old install.sh fetched from ${OLD_NEMOCLAW_REF}`,
        "real Docker/OpenShell gateway, dashboard forward, and fixture-declared OpenClaw sandboxes",
        "exact-name confirmation for the known-managed legacy fixture",
        "current scripts/install.sh gateway upgrade path",
        "equivalent current-owned dashboard forward after upgrade",
        "gateway credential absent from sandbox environment and managed OpenClaw files",
        "authenticated OpenClaw turns before and after upgrade",
        "durable workspace restore and survivor discovery through the current CLI",
        "stopped-sandbox phase restoration and current lifecycle usability",
      ],
      oldNemoclawRef: OLD_NEMOCLAW_REF,
      oldNemoclawCommit: OLD_NEMOCLAW_COMMIT,
      oldInstallerSha256: OLD_INSTALLER_SHA256,
      oldOpenShellVersion: OLD_OPENSHELL_VERSION,
      oldOpenClawVersion: OLD_OPENCLAW_VERSION,
      oldSandboxBaseImageRef: OLD_SANDBOX_BASE_IMAGE_REF,
      currentOpenShellVersion: CURRENT_OPENSHELL_VERSION,
      survivorSandbox: SURVIVOR_SANDBOX,
      legacySandboxes: LEGACY_SANDBOXES,
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
    for (const sandboxName of LEGACY_SANDBOXES) {
      cleanup.trackDisposable(`remove openshell gateway upgrade sandbox ${sandboxName}`, () =>
        sandbox.cleanupSandbox(sandboxName, {
          artifactName: `cleanup-${sandboxName}`,
          env: liveEnv(),
          timeoutMs: 120_000,
        }),
      );
    }

    // Vitest retries execute in the same runner process. Tear down any failed
    // legacy gateway before each attempt so partial containerd layers from a
    // transient image-import failure cannot consume the next attempt's disk.
    await preCleanUpgradeGateway(host, "pre-cleanup-gateway");

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: GATEWAY_CREDENTIAL,
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

    progress.phase("create and stop the fixture-declared additional sandboxes");
    await createStoppedLegacySandboxes(host, fake.baseUrl);

    progress.phase("verify legacy credential custody and write durable workspace state");
    const legacyCredentialBoundary = await collectOpenClawCredentialBoundary(host, fake, "legacy");
    await writeSurvivorMarker(host);

    progress.phase("upgrade to the current OpenShell gateway");
    await installCurrentNemoclawUpgrade(host, artifacts, fake.baseUrl);

    progress.phase("verify preserved workspace state and every recovered stopped sandbox");
    await assertSurvivorSandboxAfterUpgrade(host);
    progress.phase("verify upgraded credential custody");
    const upgradedCredentialBoundary = await collectOpenClawCredentialBoundary(
      host,
      fake,
      "upgraded",
    );
    const credentialBoundaries = [legacyCredentialBoundary, upgradedCredentialBoundary];
    expect(
      credentialBoundaries.every((evidence) => evidence.valid),
      credentialBoundaries.map((evidence) => evidence.diagnostic).join("\n"),
    ).toBe(true);
  },
);
