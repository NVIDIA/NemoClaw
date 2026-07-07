// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exercises Spark installation through the live E2E harness. */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { shouldRunInstallerIntegration, shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  assertRequiredInstallerEnv,
  assertSparkInstallSandboxName,
  buildInstallerInvocation,
  DEFAULT_INSTALL_URL,
  DEFAULT_SPARK_INSTALL_SANDBOX_NAME,
  exitDetail,
  writeRedactedInstallLog,
} from "./spark-install-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = assertSparkInstallSandboxName(
  process.env.NEMOCLAW_SANDBOX_NAME ?? DEFAULT_SPARK_INSTALL_SANDBOX_NAME,
);
const LIVE_TIMEOUT_MS = 40 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const liveTest =
  process.platform === "linux" && (shouldRunLiveE2E() || shouldRunInstallerIntegration())
    ? test
    : test.skip;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function sourceInstalledPathProbe(): string {
  return [
    'if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc" 2>/dev/null || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi',
    'if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then export PATH="$HOME/.local/bin:$PATH"; fi',
    "command -v nemoclaw",
    "command -v openshell",
    "nemoclaw --help >/dev/null",
  ].join("; ");
}

async function bestEffortCleanup(host: HostCliClient): Promise<void> {
  const cleanup = [
    `if command -v nemoclaw >/dev/null 2>&1; then nemoclaw ${shellQuote(SANDBOX_NAME)} destroy --yes >/dev/null 2>&1 || true; fi`,
    `if command -v openshell >/dev/null 2>&1; then openshell sandbox delete ${shellQuote(SANDBOX_NAME)} >/dev/null 2>&1 || true; fi`,
    "if command -v openshell >/dev/null 2>&1; then openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true; fi",
  ].join("\n");
  await host.command("bash", ["-lc", cleanup], {
    artifactName: "cleanup-spark-install-state",
    env: env(),
    timeoutMs: 120_000,
  });
}

liveTest(
  "spark install path: standard non-interactive install leaves NemoClaw and OpenShell usable",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, secrets }) => {
    await artifacts.target.declare({
      id: "spark-install",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "Linux + Docker prerequisite gate",
        "NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 are required for the install",
        "standard installer path runs without Spark-specific setup",
        "optional NEMOCLAW_E2E_PUBLIC_INSTALL=1 curl|bash path is selected by the same env gate",
        "install log is retained",
        "nemoclaw and openshell are on PATH after profile refresh",
        "nemoclaw --help exits 0",
      ],
    });

    expect(process.platform).toBe("linux");

    expect(fs.existsSync(path.join(REPO_ROOT, "install.sh")), "repo install.sh must exist").toBe(
      true,
    );

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    assertRequiredInstallerEnv(process.env);

    const hosted = requireHostedInferenceConfig(secrets);
    const redactionValues = [hosted.apiKey];
    cleanup.add(`remove ${SANDBOX_NAME} after Spark install smoke`, () => bestEffortCleanup(host));
    await bestEffortCleanup(host);

    const installLog = process.env.INSTALL_LOG ?? artifacts.pathFor("logs/install.log");
    fs.mkdirSync(path.dirname(installLog), { recursive: true });
    const installer = buildInstallerInvocation({
      repoRoot: REPO_ROOT,
      env: process.env,
    });
    await artifacts.writeJson("installer.json", {
      mode: installer.mode,
      installUrl: installer.installUrl,
      installLog,
    });
    expect(installer.script).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(installer.script).toContain("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
    expect(
      installer.mode === "local"
        ? installer.script.includes("bash install.sh --non-interactive") &&
            !installer.script.includes("setup-spark")
        : installer.script.includes("curl -fsSL") && installer.installUrl === DEFAULT_INSTALL_URL,
    ).toBe(true);

    const install = await host.command("bash", ["-lc", installer.script], {
      artifactName: `phase-1-${installer.mode}-install`,
      cwd: REPO_ROOT,
      env: env(hosted.env),
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    writeRedactedInstallLog(installLog, install, redactionValues);
    expect(install.exitCode, exitDetail(install, installLog, redactionValues)).toBe(0);
    expect(fs.existsSync(installLog), `${installLog} should be written`).toBe(true);

    const installedCommands = await host.command("bash", ["-lc", sourceInstalledPathProbe()], {
      artifactName: "phase-2-installed-cli-path-probe",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(installedCommands.exitCode, resultText(installedCommands)).toBe(0);
    expect(installedCommands.stdout).toContain("nemoclaw");
    expect(installedCommands.stdout).toContain("openshell");
  },
);
