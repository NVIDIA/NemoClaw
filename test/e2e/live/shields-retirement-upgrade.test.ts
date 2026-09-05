// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One direct black-box retirement path: install a released Shields-capable
 * NemoClaw, create and lock a real sandbox, switch the host to
 * the exact candidate CLI artifact, then run the production sandbox upgrade.
 * The legacy state file is produced only by the released CLI.
 */

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
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { registerOpenShellHostMockFirewall } from "../fixtures/host-mock-firewall.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
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

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-retire-lock";
const MARKER_PATH = "/sandbox/.openclaw/workspace/shields-retirement-upgrade-marker.txt";
const MARKER_CONTENT = `shields-retirement-upgrade-${Date.now()}`;
const GATEWAY_PID_FILE = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
  "openshell-gateway.pid",
);
const CANDIDATE_CLI = process.env.NEMOCLAW_CLI_BIN ?? CLI_ENTRYPOINT;
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
    `curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/${shellQuote(RELEASE_TAG)}/install.sh -o ${shellQuote(installer)}`,
    { artifactName: "download-released-installer", timeoutMs: 90_000 },
  );
  expectExitZero(download, `download ${RELEASE_TAG} installer`);
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

  const version = await bash(host, "nemoclaw --version", {
    artifactName: "released-cli-version",
    timeoutMs: 30_000,
  });
  expectExitZero(version, "released nemoclaw --version");
  expect(resultText(version)).toContain(RELEASE_TAG.slice(1));
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
  return bash(host, `${shellQuote(CANDIDATE_CLI)} ${args.map(shellQuote).join(" ")}`, {
    artifactName,
    env: commandEnv(extraEnv),
    timeoutMs,
  });
}

test.skipIf(process.platform !== "linux")(
  "shields-retirement-upgrade: released Shields posture rebuilds with data intact and no affordance",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "clear prior fixture state",
        "install the released Shields CLI and create a real sandbox",
        "write durable user data and create the released recovery backup",
        "raise and prove Shields are up",
        "switch the host to the candidate CLI",
        "detect legacy posture and fail closed before mutation",
        "recover through the production managed sandbox upgrade",
        "verify user data runtime usability and legacy-state retirement",
        "prove the candidate exposes no Shields affordance",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    progress.phase("clear prior fixture state");
    await artifacts.writeJson("release-and-candidate-contract.json", {
      release: RELEASE_TAG,
      candidateCli: CANDIDATE_CLI,
      sandbox: SANDBOX_NAME,
      markerPath: MARKER_PATH,
    });

    const preClean = await bash(host, upgradeGatewayCleanupScript(GATEWAY_PID_FILE), {
      artifactName: "pre-clean-gateway",
      timeoutMs: 120_000,
    });
    expectExitZero(preClean, "pre-clean released gateway state");
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

    progress.phase("switch the host to the candidate CLI");

    progress.phase("detect legacy posture and fail closed before mutation");
    const detected = await candidateNemoclaw(host, ["list"], "candidate-retirement-notice");
    expectExitZero(detected, "candidate retirement notice");
    const notice = resultText(detected);
    expect(notice).toMatch(/Shields has been retired/iu);
    expect(notice).toMatch(/Back up.+rebuild or recreate/isu);
    const blocked = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "exec", "--", "true"],
      "candidate-fail-closed-exec",
    );
    expect(blocked.exitCode).not.toBe(0);

    progress.phase("recover through the production managed sandbox upgrade");
    const upgrade = await candidateNemoclaw(
      host,
      ["upgrade-sandboxes", "--auto"],
      "candidate-upgrade-retired-shields",
      50 * 60_000,
      { NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1" },
    );
    expectExitZero(upgrade, "candidate managed upgrade of retired Shields sandbox");

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

    progress.phase("prove the candidate exposes no Shields affordance");
    const topHelp = await candidateNemoclaw(host, ["--help"], "candidate-top-help");
    expectExitZero(topHelp, "candidate top-level help");
    expect(resultText(topHelp)).not.toMatch(/\bShields\b/iu);
    const removedUp = await candidateNemoclaw(
      host,
      [SANDBOX_NAME, "shields", "up"],
      "candidate-removed-shields-up",
    );
    expect(removedUp.exitCode).not.toBe(0);
  },
);
