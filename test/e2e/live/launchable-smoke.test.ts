// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  DEFAULT_HOSTED_INFERENCE_MODEL,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

// This is intentionally a single live test instead of a new fixture
// family: the contract is the real Ubuntu bootstrap path, so the test invokes
// scripts/brev-launchable-ci-cpu.sh via sudo, then proves the bootstrap-built
// CLI can onboard and run an OpenClaw agent turn through Vitest.

const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, "scripts", "brev-launchable-ci-cpu.sh");
const MODEL =
  process.env.NEMOCLAW_MODEL ?? process.env.NEMOCLAW_COMPAT_MODEL ?? DEFAULT_HOSTED_INFERENCE_MODEL;
const DEFAULT_SANDBOX_NAME = `e2e-boot-${randomUUID().slice(0, 8)}`;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? DEFAULT_SANDBOX_NAME;
const TEST_TIMEOUT_MS = testTimeout(30 * 60_000);
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const ONBOARD_TIMEOUT_MS = execTimeout(15 * 60_000);
const INFERENCE_TIMEOUT_MS = 2 * 60_000;
const ONBOARD_ATTEMPTS = 3;

function runEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

async function runBash(
  host: HostCliClient,
  script: string,
  options: {
    artifactName: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    redactionValues?: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    cwd: options.cwd,
    env: options.env ?? runEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs,
  });
}

async function preseedBootstrapClone(
  host: HostCliClient,
  cloneDir: string,
  artifacts: ArtifactSink,
): Promise<void> {
  const reviewedSdk = path.join(REPO_ROOT, "node_modules", "@nvidia", "openshell-sdk");
  await artifacts.writeJson("bootstrap-clone.json", { cloneDir, ref: "main" });
  const result = await runBash(
    host,
    [
      `rm -rf ${JSON.stringify(cloneDir)}`,
      `git clone --local --no-hardlinks ${JSON.stringify(REPO_ROOT)} ${JSON.stringify(cloneDir)}`,
      `git -C ${JSON.stringify(cloneDir)} checkout -B main HEAD`,
      `git -C ${JSON.stringify(cloneDir)} remote set-url origin ${JSON.stringify(cloneDir)}`,
      `test -f ${JSON.stringify(path.join(reviewedSdk, "package.json"))}`,
      `install -d -m 0755 ${JSON.stringify(path.join(cloneDir, "node_modules", "@nvidia"))}`,
      `cp -aL ${JSON.stringify(reviewedSdk)} ${JSON.stringify(path.join(cloneDir, "node_modules", "@nvidia", "openshell-sdk"))}`,
    ].join(" && "),
    {
      artifactName: "phase-0-preseed-bootstrap-clone",
      env: runEnv(),
      timeoutMs: 120_000,
    },
  );
  expectExitZero(result, "preseed bootstrap clone");
}

async function cleanupBootstrapState(host: HostCliClient, cloneDir: string): Promise<void> {
  await runBash(
    host,
    [
      `if command -v nemoclaw >/dev/null 2>&1; then nemoclaw ${JSON.stringify(SANDBOX_NAME)} destroy --yes 2>/dev/null || true; fi`,
      `if command -v openshell >/dev/null 2>&1; then openshell sandbox delete ${JSON.stringify(SANDBOX_NAME)} 2>/dev/null || true; fi`,
      "if command -v openshell >/dev/null 2>&1; then openshell gateway destroy -g nemoclaw 2>/dev/null || true; fi",
      `sudo rm -rf ${JSON.stringify(cloneDir)} 2>/dev/null || rm -rf ${JSON.stringify(cloneDir)} || true`,
    ].join("\n"),
    {
      artifactName: "cleanup-bootstrap-state",
      env: runEnv({ PATH: `/usr/local/bin:${process.env.PATH ?? ""}` }),
      timeoutMs: 180_000,
    },
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  "bootstrap install smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm bootstrap host prerequisites",
        "prepare a fresh bootstrap clone",
        "run the Brev bootstrap script",
        "prove the installed CLI launches",
        "onboard the hosted inference sandbox",
        "inspect sandbox health",
        "prove an OpenClaw agent request",
        "destroy the bootstrap sandbox and clone",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    validateSandboxName(SANDBOX_NAME);

    await artifacts.target.declare({
      id: "bootstrap-install-smoke",
      boundary: "ubuntu-bootstrap-install-flow",
      refs: ["#2599", "#5098", "#12192"],
      phases: [
        "preseed-bootstrap-clone",
        "prerequisites",
        "brev-bootstrap-script",
        "installed-cli",
        "onboard",
        "sandbox-health",
        "agent-request",
        "cleanup",
      ],
    });

    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    expect(fs.existsSync(BOOTSTRAP_SCRIPT), `${BOOTSTRAP_SCRIPT} missing`).toBe(true);

    const sudo = await host.command("sudo", ["-n", "true"], {
      artifactName: "prereq-passwordless-sudo",
      env: runEnv(),
      timeoutMs: 30_000,
    });
    if (sudo.exitCode !== 0) skip("passwordless sudo is required for bootstrap install smoke");

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-docker-info",
      scenarioLabel: "bootstrap install smoke",
    });

    progress.phase("prepare a fresh bootstrap clone");
    const cloneDir = path.join(os.tmpdir(), `NemoClaw-bootstrap-${randomUUID()}`);
    cleanup.add(`remove bootstrap clone ${cloneDir}`, async () =>
      cleanupBootstrapState(host, cloneDir),
    );
    await cleanupBootstrapState(host, cloneDir);
    await preseedBootstrapClone(host, cloneDir, artifacts);

    progress.phase("run the Brev bootstrap script");
    const installLog = artifacts.pathFor("bootstrap.log");
    const install = await host.command("sudo", ["-E", "bash", BOOTSTRAP_SCRIPT], {
      artifactName: "phase-2-brev-bootstrap-script",
      env: runEnv({
        LAUNCH_LOG: installLog,
        NEMOCLAW_CLONE_DIR: cloneDir,
        NEMOCLAW_REF: "main",
        SKIP_DOCKER_PULL: process.env.SKIP_DOCKER_PULL ?? "1",
      }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    expectExitZero(install, "Brev bootstrap script completed");

    progress.phase("prove the installed CLI launches");
    const pathEnv = runEnv({
      PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
    });

    const nemoclawHelp = await runBash(host, "command -v nemoclaw && nemoclaw --help >/dev/null", {
      artifactName: "phase-3-nemoclaw-help",
      env: pathEnv,
      timeoutMs: 30_000,
    });
    expectExitZero(nemoclawHelp, "nemoclaw is on PATH and --help works");

    progress.phase("onboard the hosted inference sandbox");
    let onboard: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt += 1) {
      onboard = await host.command("nemoclaw", ["onboard", "--non-interactive"], {
        artifactName: attempt === 1 ? "phase-4-onboard" : `phase-4-onboard-attempt-${attempt}`,
        cwd: cloneDir,
        env: runEnv({
          PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
          ...hosted.env,
          NEMOCLAW_MODEL: MODEL,
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      });
      if (onboard.exitCode === 0) break;
      if (isTransientProviderValidationFailure(onboard) && attempt < ONBOARD_ATTEMPTS) {
        await sleep(30_000 * attempt);
        continue;
      }
      if (isTransientProviderValidationFailure(onboard) && process.env.GITHUB_ACTIONS === "true") {
        await artifacts.writeJson("transient-provider-validation.skip.json", {
          reason: "transient NVIDIA Endpoints validation failure during bootstrap onboard",
          attempts: ONBOARD_ATTEMPTS,
          sourceBoundary: "external NVIDIA Endpoints provider availability",
          removalCondition:
            "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture",
        });
        skip(
          `NVIDIA Endpoints validation hit a transient upstream/rate-limit failure after ${ONBOARD_ATTEMPTS} attempts`,
        );
      }
      break;
    }
    expectExitZero(onboard as ShellProbeResult, "nemoclaw onboard --non-interactive");

    progress.phase("inspect sandbox health");
    const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
      artifactName: "phase-5-nemoclaw-status",
      cwd: cloneDir,
      env: pathEnv,
      timeoutMs: 60_000,
    });
    expectExitZero(status, `nemoclaw ${SANDBOX_NAME} status`);

    progress.phase("prove an OpenClaw agent request");
    const sandboxExec = (command: string[], artifactName: string) =>
      sandbox.exec(SANDBOX_NAME, command, {
        artifactName,
        env: pathEnv,
        timeoutMs: INFERENCE_TIMEOUT_MS,
      });
    const sessionId = `e2e-bootstrap-${Date.now()}-${randomUUID()}`;
    const agent = await sandboxExec(
      [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--thinking",
        "off",
        "--session-id",
        sessionId,
        "-m",
        "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      ],
      "phase-6-openclaw-agent",
    );
    expect(
      agent.exitCode,
      `openclaw agent failed; rc=${agent.exitCode}; stdout='${agent.stdout.slice(0, 300)}'; stderr='${agent.stderr.slice(0, 300)}'`,
    ).toBe(0);
    const agentReply = parseOpenClawAgentText(agent.stdout);
    expect(
      containsAnswer(agentReply, "42"),
      `expected agent reply to contain 42; rc=${agent.exitCode}; reply='${agentReply.slice(0, 200)}'; stdout='${agent.stdout.slice(0, 300)}'; stderr='${agent.stderr.slice(0, 300)}'`,
    ).toBe(true);

    progress.phase("destroy the bootstrap sandbox and clone");
    const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "phase-7-nemoclaw-destroy",
      cwd: cloneDir,
      env: pathEnv,
      timeoutMs: 120_000,
    });
    expectExitZero(destroy, `destroy ${SANDBOX_NAME}`);
    await cleanupBootstrapState(host, cloneDir);
  },
);
