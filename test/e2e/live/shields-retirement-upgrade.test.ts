// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One direct black-box retirement path: install a released Shields-capable
 * NemoClaw, create and lock a real sandbox, switch the host to
 * the exact candidate CLI artifact, then run the production sandbox upgrade.
 * The legacy state file is produced only by the released CLI.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { assertNoDockerfileBuild, createDockerBuildGuard } from "../fixtures/docker-build-guard.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { registerOpenShellHostMockFirewall } from "../fixtures/host-mock-firewall.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { pollUntil } from "../fixtures/polling.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  legacyGatewayUpgradeHostFirewallOptions,
  oldGatewayUpgradeInstallerArgs,
  throwGatewayUpgradeSetupFailures,
  upgradeGatewayCleanupScript,
  upgradeGatewayStateCleanupScript,
} from "./openshell-gateway-upgrade-helpers.ts";

const RELEASE_TAG = process.env.NEMOCLAW_OLD_NEMOCLAW_REF ?? "v0.0.115";
const RELEASE_TAG_OBJECT =
  process.env.NEMOCLAW_OLD_NEMOCLAW_TAG_OBJECT ?? "7503e700808655df1303ddc51888bb596c9afa34";
const RELEASE_COMMIT =
  process.env.NEMOCLAW_OLD_NEMOCLAW_COMMIT ?? "324a886fd05b01f6756bae0371ea503c651fbd11";
const RELEASE_INSTALLER_SHA256 =
  process.env.NEMOCLAW_OLD_INSTALLER_SHA256 ??
  "0ed77ba8cf176641bd3b22cfd89b4977b3d9a6f47b76da8b03bf4091a20d1251";
const RELEASE_OPENSHELL_VERSION = process.env.NEMOCLAW_OLD_OPENSHELL_VERSION ?? "0.0.106";
const RELEASE_OPENCLAW_VERSION = process.env.NEMOCLAW_OLD_OPENCLAW_VERSION ?? "2026.7.1";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-retire-lock";
const MARKER_PATH = "/sandbox/.openclaw/workspace/shields-retirement-upgrade-marker.txt";
const MARKER_CONTENT = `shields-retirement-upgrade-${Date.now()}`;
const NEMOCLAW_STATE_DIR = path.join(os.homedir(), ".nemoclaw", "state");
const LEGACY_STATE_RECORD = path.join(NEMOCLAW_STATE_DIR, `shields-${SANDBOX_NAME}.json`);
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const GATEWAY_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
);
const GATEWAY_PID_FILE = path.join(GATEWAY_STATE_DIR, "openshell-gateway.pid");
const CANDIDATE_CLI = process.env.NEMOCLAW_CLI_BIN ?? path.join(REPO_ROOT, "bin", "nemoclaw.js");
const EXPECTED_CANDIDATE_SHA = process.env.NEMOCLAW_E2E_EXPECTED_SHA?.trim() ?? "";
const COMMAND_TIMEOUT_MS = 2 * 60_000;
const TEST_TIMEOUT_MS = 115 * 60_000;

validateSandboxName(SANDBOX_NAME);
expect(SANDBOX_NAME.startsWith("e2e-retire-")).toBe(true);
expect(SANDBOX_NAME.length).toBeLessThanOrEqual(19);

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function shellLoginPrefix(): string {
  return [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc" 2>/dev/null || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi',
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  ].join("\n");
}

async function bash(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    env?: NodeJS.ProcessEnv;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", `${shellLoginPrefix()}\n${script}`], {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function runReleasedInstaller(
  host: HostCliClient,
  installerArgs: readonly string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const invocation = `bash ${installerArgs.map(shellQuote).join(" ")} >${shellQuote(logFile)} 2>&1`;
  const result = await bash(host, `rm -f ${shellQuote(logFile)}\n${invocation}`, {
    artifactName: "released-installer",
    env,
    timeoutMs: GATEWAY_UPGRADE_INSTALL_TIMEOUT_MS,
  });
  const tail = await bash(host, `tail -200 ${shellQuote(logFile)} 2>/dev/null || true`, {
    artifactName: "released-installer-tail",
    timeoutMs: 30_000,
  });
  expect(result.exitCode, `released installer failed:\n${resultText(tail)}`).toBe(0);
}

async function waitForSandboxReady(host: HostCliClient, artifactPrefix: string): Promise<void> {
  await pollUntil({
    artifactPrefix,
    attempts: 60,
    delayMs: 2_000,
    probe: (_attempt, artifactName) =>
      bash(host, "openshell sandbox list", { artifactName, timeoutMs: 30_000 }),
    accept: (result) =>
      result.exitCode === 0 && new RegExp(`${SANDBOX_NAME}.*Ready`).test(resultText(result)),
  });
}

async function installReleasedNemoclaw(
  host: HostCliClient,
  artifacts: ArtifactSink,
  fakeBaseUrl: string,
): Promise<void> {
  const installer = artifacts.pathFor("released-install.sh");
  const installLog = artifacts.pathFor("released-install.log");
  const download = await bash(
    host,
    `curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/${shellQuote(RELEASE_COMMIT)}/install.sh -o ${shellQuote(installer)}`,
    { artifactName: "download-released-installer", timeoutMs: 90_000 },
  );
  expectExitZero(download, `download ${RELEASE_TAG} installer`);
  expect(createHash("sha256").update(fs.readFileSync(installer)).digest("hex")).toBe(
    RELEASE_INSTALLER_SHA256,
  );
  fs.chmodSync(installer, 0o755);
  await runReleasedInstaller(
    host,
    oldGatewayUpgradeInstallerArgs(installer),
    installLog,
    commandEnv({
      COMPATIBLE_API_KEY: "dummy",
      E2E_MANAGED_IMAGE_COHORT_RECEIPT: "",
      E2E_MANAGED_IMAGE_REVISION: "",
      E2E_WORKLOAD_SOURCE: "",
      GITHUB_ACTIONS: "",
      GITHUB_WORKSPACE: "",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_BOOTSTRAP_PAYLOAD: "1",
      NEMOCLAW_COMPAT_MODEL: "test-model",
      NEMOCLAW_E2E_EXPECTED_SHA: "",
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "",
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: "",
      NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
      NEMOCLAW_IGNORE_RUNTIME_RESOURCES: "1",
      NEMOCLAW_INSTALL_REF: "",
      NEMOCLAW_INSTALL_TAG: RELEASE_TAG,
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_RUN_LIVE_E2E: "",
      NEMOCLAW_SANDBOX_GPU: "0",
    }),
  );

  const sourceHead = await bash(host, 'git -C "$HOME/.nemoclaw/source" rev-parse --verify HEAD', {
    artifactName: "released-source-head",
    timeoutMs: 30_000,
  });
  expectExitZero(sourceHead, "read installed release source head");
  expect(sourceHead.stdout.trim()).toBe(RELEASE_COMMIT);
  const version = await bash(host, "nemoclaw --version", {
    artifactName: "released-cli-version",
    timeoutMs: 30_000,
  });
  expectExitZero(version, "released nemoclaw --version");
  expect(resultText(version)).toContain(RELEASE_TAG.slice(1));
  const openShellVersion = await bash(host, "openshell --version", {
    artifactName: "released-openshell-version",
    timeoutMs: 30_000,
  });
  expectExitZero(openShellVersion, "released openshell --version");
  expect(resultText(openShellVersion)).toContain(RELEASE_OPENSHELL_VERSION);
  await waitForSandboxReady(host, "released-install");
}

async function releasedNemoclaw(
  host: HostCliClient,
  args: readonly string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  return bash(host, `nemoclaw ${args.map(shellQuote).join(" ")}`, {
    artifactName,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function candidateNemoclaw(
  host: HostCliClient,
  args: readonly string[],
  artifactName: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ShellProbeResult> {
  return bash(host, `nemoclaw ${args.map(shellQuote).join(" ")}`, {
    artifactName,
    env: commandEnv(extraEnv),
    timeoutMs,
  });
}

type ManagedRegistryEntry = {
  fromDockerfile?: unknown;
  imageTag?: unknown;
  workload?: {
    kind?: unknown;
    reference?: unknown;
    release?: unknown;
    shared?: unknown;
    sourceCohort?: unknown;
    sourceRevision?: unknown;
  };
};

function registryEntry(): ManagedRegistryEntry {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, ManagedRegistryEntry>;
  };
  const entry = registry.sandboxes?.[SANDBOX_NAME];
  expect(entry, `managed sandbox '${SANDBOX_NAME}' must be registered`).toEqual(expect.any(Object));
  return entry!;
}

function expectCandidateManagedSandbox(): void {
  const rawCatalog = process.env.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON?.trim() ?? "";
  expect(rawCatalog).not.toBe("");
  const catalog = JSON.parse(rawCatalog) as {
    openclaw?: {
      reference?: unknown;
      source?: { cohort?: unknown; release?: unknown; revision?: unknown };
    };
  };
  const contract = catalog.openclaw;
  expect(contract).toEqual(expect.any(Object));
  expect(contract?.source?.revision).toBe(EXPECTED_CANDIDATE_SHA);
  expect(contract?.reference).toMatch(
    /^ghcr\.io\/nvidia\/nemoclaw\/openclaw-sandbox@sha256:[0-9a-f]{64}$/u,
  );

  expect(
    assertStockManagedImageReceipt({
      environment: commandEnv(),
      expectedAgent: "openclaw",
      sandboxName: SANDBOX_NAME,
    }),
  ).toMatchObject({
    agent: "openclaw",
    reference: contract?.reference,
    sourceCohort: contract?.source?.cohort,
    sourceRevision: EXPECTED_CANDIDATE_SHA,
  });
  const entry = registryEntry();
  expect(entry.fromDockerfile).toBeNull();
  expect(entry.imageTag).toBe(contract?.reference);
  expect(entry.workload).toMatchObject({
    kind: "managed-image",
    reference: contract?.reference,
    release: contract?.source?.release,
    shared: true,
    sourceCohort: contract?.source?.cohort,
    sourceRevision: EXPECTED_CANDIDATE_SHA,
  });
}

function expectLegacyStateRecord(): void {
  const noFollow = fs.constants.O_NOFOLLOW as number;
  expect(Number.isInteger(noFollow)).toBe(true);
  const descriptor = fs.openSync(LEGACY_STATE_RECORD, fs.constants.O_RDONLY | noFollow);
  try {
    const metadata = fs.fstatSync(descriptor);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.size).toBeLessThanOrEqual(1024 * 1024);
    const state = JSON.parse(fs.readFileSync(descriptor, "utf8")) as {
      fileHashes?: unknown;
      shieldsDown?: unknown;
    };
    expect(state.shieldsDown).toBe(false);
    expect(state.fileHashes).toEqual(expect.any(Object));
  } finally {
    fs.closeSync(descriptor);
  }
}

function expectRemovedShieldsCommand(result: ShellProbeResult, command: string): void {
  expect(result.exitCode, `candidate must reject shields ${command}`).not.toBe(0);
  const output = resultText(result);
  expect(output).toMatch(/Unknown|not found|unrecognized/iu);
  expect(output).not.toMatch(
    /Shields:\s*(?:UP|DOWN|NOT CONFIGURED)|Lockdown active|Config unlocked|Raise sandbox security shields|Show current shields state/iu,
  );
}

test.skipIf(process.platform !== "linux")(
  "shields-retirement-upgrade: released Shields posture rebuilds with data intact and no affordance",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "clear prior fixture state and bind immutable release artifacts",
        "install the released Shields CLI and create a real sandbox",
        "write durable user data and create the released recovery backup",
        "raise and prove Shields are up",
        "switch the host to the exact candidate CLI artifact",
        "detect legacy posture and fail closed before mutation",
        "recover through the production managed sandbox upgrade",
        "verify user data runtime usability and legacy-state retirement",
        "prove the candidate exposes no Shields affordance",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    progress.phase("clear prior fixture state and bind immutable release artifacts");
    await artifacts.writeJson("release-and-candidate-contract.json", {
      release: {
        tag: RELEASE_TAG,
        tagObject: RELEASE_TAG_OBJECT,
        commit: RELEASE_COMMIT,
        installerSha256: RELEASE_INSTALLER_SHA256,
        openShellVersion: RELEASE_OPENSHELL_VERSION,
        openClawVersion: RELEASE_OPENCLAW_VERSION,
      },
      candidate: {
        cli: CANDIDATE_CLI,
        expectedSha: EXPECTED_CANDIDATE_SHA,
        managedImageRevision: process.env.E2E_MANAGED_IMAGE_REVISION ?? null,
        workloadSource: process.env.E2E_WORKLOAD_SOURCE ?? null,
      },
      sandbox: SANDBOX_NAME,
      markerPath: MARKER_PATH,
    });

    const preClean = await bash(host, upgradeGatewayCleanupScript(GATEWAY_PID_FILE), {
      artifactName: "pre-clean-gateway",
      timeoutMs: 120_000,
    });
    expectExitZero(preClean, "pre-clean released gateway state");
    fs.rmSync(LEGACY_STATE_RECORD, { force: true });
    const releaseRef = await bash(
      host,
      `git ls-remote https://github.com/NVIDIA/NemoClaw.git ${shellQuote(`refs/tags/${RELEASE_TAG}`)} ${shellQuote(`refs/tags/${RELEASE_TAG}^{}`)}`,
      { artifactName: "released-tag-identity", timeoutMs: 90_000 },
    );
    expectExitZero(releaseRef, `resolve published ${RELEASE_TAG} tag`);
    expect(releaseRef.stdout).toContain(`${RELEASE_TAG_OBJECT}\trefs/tags/${RELEASE_TAG}`);
    expect(releaseRef.stdout).toContain(`${RELEASE_COMMIT}\trefs/tags/${RELEASE_TAG}^{}`);

    cleanup.trackDisposable("remove exact legacy Shields record after sandbox cleanup", () => {
      fs.rmSync(LEGACY_STATE_RECORD, { force: true });
    });
    cleanup.trackDisposable("remove released gateway state", async () => {
      const result = await bash(host, upgradeGatewayStateCleanupScript(GATEWAY_PID_FILE), {
        artifactName: "cleanup-gateway-state",
        timeoutMs: 120_000,
      });
      expectExitZero(result, "cleanup released gateway state");
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-gateway",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    cleanup.trackDisposable(`delete fixture sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-sandbox",
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: "dummy",
      host: "0.0.0.0",
      model: "test-model",
      progress,
      publicHost: "host.openshell.internal",
      responseText: "ok",
    });
    let firewallSetup: ReturnType<typeof registerOpenShellHostMockFirewall>;
    try {
      firewallSetup = registerOpenShellHostMockFirewall({
        cleanup,
        host,
        port: Number(new URL(fake.baseUrl).port),
        ...legacyGatewayUpgradeHostFirewallOptions(RELEASE_TAG),
      });
    } catch (error) {
      await fake.close();
      throw error;
    }
    cleanup.add("close compatible endpoint mock", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
      await fake.close();
    });

    progress.phase("install the released Shields CLI and create a real sandbox");
    const setupResults = await Promise.allSettled([
      installReleasedNemoclaw(host, artifacts, fake.baseUrl),
      firewallSetup.then((result) => artifacts.writeJson("host-mock-firewall.json", result)),
    ]);
    throwGatewayUpgradeSetupFailures(setupResults);

    const releasedOpenClawVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
      artifactName: "released-openclaw-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expectExitZero(releasedOpenClawVersion, "released OpenClaw version");
    expect(resultText(releasedOpenClawVersion)).toContain(RELEASE_OPENCLAW_VERSION);

    progress.phase("write durable user data and create the released recovery backup");
    const markerWrite = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        `mkdir -p $(dirname ${shellQuote(MARKER_PATH)}) && printf '%s' ${shellQuote(MARKER_CONTENT)} >${shellQuote(MARKER_PATH)}`,
      ],
      {
        artifactName: "write-user-data-marker",
        env: commandEnv(),
        timeoutMs: 60_000,
      },
    );
    expectExitZero(markerWrite, "write durable user-data marker");
    const releasedBackup = await releasedNemoclaw(
      host,
      ["backup-all"],
      "released-backup-before-shields",
    );
    expectExitZero(releasedBackup, "released pre-upgrade backup");
    expect(resultText(releasedBackup)).toContain(
      "Pre-upgrade backup: 1 backed up, 0 failed, 0 skipped",
    );

    progress.phase("raise and prove Shields are up");
    const shieldsUp = await releasedNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "up"],
      "released-shields-up",
    );
    expectExitZero(shieldsUp, "released shields up");
    expect(resultText(shieldsUp)).toContain("Lockdown active");
    const shieldsStatus = await releasedNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "status"],
      "released-shields-status",
    );
    expectExitZero(shieldsStatus, "released shields status");
    expect(resultText(shieldsStatus)).toContain("Shields: UP (lockdown active)");
    expect(resultText(shieldsStatus)).toContain("Policy:  restrictive");
    expectLegacyStateRecord();

    progress.phase("switch the host to the exact candidate CLI artifact");
    expect(process.env.E2E_WORKLOAD_SOURCE).toBe("managed-image");
    expect(process.env.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON?.trim()).not.toBe("");
    const dockerBuildGuard = createDockerBuildGuard();
    fs.writeFileSync(dockerBuildGuard.tracePath, "", { flag: "wx", mode: 0o600 });
    const originalPath = process.env.PATH ?? "";
    expect(originalPath).not.toBe("");
    process.env.PATH = dockerBuildGuard.env.PATH;
    cleanup.add("restore PATH and dispose the candidate Dockerfile build guard", () => {
      process.env.PATH = originalPath;
      dockerBuildGuard.dispose();
    });
    const candidateRealPath = fs.realpathSync(CANDIDATE_CLI);
    expect(path.isAbsolute(candidateRealPath)).toBe(true);
    const candidateIdentity = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "dist", "build-identity.json"), "utf8"),
    ) as { sourceRevision?: unknown };
    expect(EXPECTED_CANDIDATE_SHA).toMatch(/^[0-9a-f]{40}$/u);
    expect(candidateIdentity.sourceRevision).toBe(EXPECTED_CANDIDATE_SHA);
    const activateCandidate = await bash(
      host,
      `cd ${shellQuote(REPO_ROOT)}\nnpm link --ignore-scripts\nhash -r`,
      { artifactName: "activate-candidate-cli", timeoutMs: 5 * 60_000 },
    );
    expectExitZero(activateCandidate, "activate exact candidate CLI artifact");
    const candidatePath = await bash(
      host,
      'candidate="$(command -v nemoclaw)"\nprintf "%s\\n" "$candidate"\nreadlink -f "$candidate"',
      { artifactName: "candidate-cli-path", timeoutMs: 30_000 },
    );
    expectExitZero(candidatePath, "resolve activated candidate CLI");
    expect(candidatePath.stdout.trim().split("\n").at(-1)).toBe(candidateRealPath);
    const candidateVersion = await candidateNemoclaw(host, ["--version"], "candidate-version");
    expectExitZero(candidateVersion, "candidate nemoclaw --version");
    expect(resultText(candidateVersion)).toContain(EXPECTED_CANDIDATE_SHA.slice(0, 10));
    expectLegacyStateRecord();

    progress.phase("detect legacy posture and fail closed before mutation");
    const detected = await candidateNemoclaw(host, ["list"], "candidate-retirement-notice");
    expectExitZero(detected, "candidate retirement notice");
    const notice = resultText(detected);
    expect(notice).toContain(
      "Shields has been retired from NemoClaw. This release has no Shields commands or supported Shields posture.",
    );
    expect(notice).toContain(`Affected sandbox records: ${SANDBOX_NAME}.`);
    expect(notice).toContain(
      "Back up trusted user data and rebuild or recreate affected sandboxes with the current version.",
    );
    expect(notice).not.toContain(
      "Unattributed transition or provider recovery state also remains.",
    );
    const blocked = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "exec", "--", "true"],
      "candidate-fail-closed-exec",
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(resultText(blocked)).toContain(
      `Sandbox '${SANDBOX_NAME}' has a state record from the removed Shields feature. Its current mutable posture cannot be proven.`,
    );
    expect(resultText(blocked)).toContain(
      "Create a trusted snapshot or backup, then use the supported rebuild/recreate path before other mutations.",
    );
    expectLegacyStateRecord();

    progress.phase("recover through the production managed sandbox upgrade");
    expectLegacyStateRecord();
    const upgrade = await candidateNemoclaw(
      host,
      ["upgrade-sandboxes", "--auto"],
      "candidate-upgrade-retired-shields",
      50 * 60_000,
      { NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1" },
    );
    expectExitZero(upgrade, "candidate managed upgrade of retired Shields sandbox");
    const upgradeOutput = resultText(upgrade);
    expect(upgradeOutput).toContain(
      "Shields has been retired from NemoClaw. This release has no Shields commands or supported Shields posture.",
    );
    expect(upgradeOutput).toContain("Prepared backup recovery:");
    expect(upgradeOutput).toContain("1 sandbox(es) rebuilt.");
    expect(upgradeOutput).not.toContain("sandbox(es) failed");

    progress.phase("verify user data runtime usability and legacy-state retirement");
    const markerRead = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "exec", "--", "cat", MARKER_PATH],
      "candidate-read-preserved-marker",
    );
    expectExitZero(markerRead, "read user-data marker after retirement rebuild");
    expect(markerRead.stdout).toBe(MARKER_CONTENT);
    const mutableProbe = await candidateNemoclaw(
      host,
      [
        SANDBOX_NAME,
        "exec",
        "--",
        "sh",
        "-lc",
        "printf '%s' usable-after-shields-retirement > /sandbox/.openclaw/workspace/.retirement-mutable-probe && cat /sandbox/.openclaw/workspace/.retirement-mutable-probe",
      ],
      "candidate-mutable-workspace-probe",
    );
    expectExitZero(mutableProbe, "write user data after retirement rebuild");
    expect(mutableProbe.stdout).toBe("usable-after-shields-retirement");
    const status = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "status"],
      "candidate-status-after-retirement",
    );
    expectExitZero(status, "candidate sandbox status after retirement rebuild");
    expect(resultText(status)).not.toMatch(/\bShields\b/iu);
    expect(fs.existsSync(LEGACY_STATE_RECORD)).toBe(false);
    expectCandidateManagedSandbox();

    progress.phase("prove the candidate exposes no Shields affordance");
    const topHelp = await candidateNemoclaw(host, ["--help"], "candidate-top-help");
    expectExitZero(topHelp, "candidate top-level help");
    expect(resultText(topHelp)).not.toMatch(/\bShields\b/iu);
    const commands = await candidateNemoclaw(
      host,
      ["--dump-commands"],
      "candidate-command-registry",
    );
    expectExitZero(commands, "candidate command registry");
    expect(resultText(commands)).not.toMatch(/\bShields\b/iu);
    const sandboxHelp = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "--help"],
      "candidate-sandbox-help",
    );
    expectExitZero(sandboxHelp, "candidate sandbox help");
    expect(resultText(sandboxHelp)).not.toMatch(/\bShields\b/iu);
    const removedUp = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "up"],
      "candidate-removed-shields-up",
    );
    expectRemovedShieldsCommand(removedUp, "up");
    const removedDown = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "down"],
      "candidate-removed-shields-down",
    );
    expectRemovedShieldsCommand(removedDown, "down");
    const removedStatus = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "status"],
      "candidate-removed-shields-status",
    );
    expectRemovedShieldsCommand(removedStatus, "status");
    const dockerTrace = fs.readFileSync(dockerBuildGuard.tracePath, "utf8");
    await artifacts.writeText("docker-build-guard.log", dockerTrace);
    assertNoDockerfileBuild(dockerTrace);
  },
);
