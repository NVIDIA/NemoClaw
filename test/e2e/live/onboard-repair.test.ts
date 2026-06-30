// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-repair";
const OTHER_SANDBOX_NAME = process.env.NEMOCLAW_OTHER_SANDBOX_NAME ?? "e2e-repair-other";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const LIVE_TIMEOUT_MS = 70 * 60_000;
const liveTest = shouldRunLiveE2E() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);
validateSandboxName(OTHER_SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function nemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 20 * 60_000,
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    timeoutMs,
  });
}

function onboardEnv(sandboxName: string, fakeBaseUrl: string, extra: NodeJS.ProcessEnv = {}) {
  return env({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    ...extra,
  });
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  for (const name of [SANDBOX_NAME, OTHER_SANDBOX_NAME]) {
    await nemoclaw(host, [name, "destroy", "--yes"], `cleanup-destroy-${name}`).catch(
      () => undefined,
    );
    await sandbox
      .openshell(["sandbox", "delete", name], {
        artifactName: `cleanup-openshell-delete-${name}`,
        env: env(),
        timeoutMs: 60_000,
      })
      .catch(() => undefined);
  }
  await sandbox
    .openshell(["forward", "stop", "18789"], {
      artifactName: "cleanup-forward-stop-18789",
      env: env(),
      timeoutMs: 30_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  fs.rmSync(SESSION_FILE, { force: true });
}

async function waitSandboxAbsent(sandbox: SandboxClient, name: string): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await sandbox.openshell(["sandbox", "get", name], {
      artifactName: `wait-${name}-absent-${attempt}`,
      env: env(),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 && /NotFound|not found/i.test(resultText(result))) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${name} still exists after forced deletion`);
}

liveTest(
  "onboard repair resumes missing sandbox and rejects conflicting resume inputs",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, skip }) => {
    await artifacts.writeJson("target.json", {
      id: "onboard-repair",
      sandboxName: SANDBOX_NAME,
      otherSandboxName: OTHER_SANDBOX_NAME,
      contracts: [
        "forced policy-step failure leaves a resumable session",
        "resume recreates a recorded sandbox that was removed underneath it",
        "resume rejects a different requested sandbox name",
        "resume rejects provider/model overrides that conflict with recorded state",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
      skip(`Docker is required: ${resultText(docker)}`);
    }

    const fake = await startFakeOpenAiCompatibleServer();
    cleanupRegistry.add("close fake OpenAI-compatible endpoint", async () => fake.close());
    cleanupRegistry.add("remove repair sandboxes", () => cleanup(host, sandbox));
    await cleanup(host, sandbox);

    const first = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-1-forced-failure",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
    );
    expect(first.exitCode, resultText(first)).toBe(1);
    expect(resultText(first)).toContain("Forced onboarding failure at step 'policies'");
    expect(fs.existsSync(SESSION_FILE)).toBe(true);

    const sandboxAfterFailure = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-1-sandbox-get-after-failure",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(sandboxAfterFailure.exitCode, resultText(sandboxAfterFailure)).toBe(0);

    await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "phase-2-delete-recorded-sandbox",
      env: env(),
      timeoutMs: 60_000,
    });
    await waitSandboxAbsent(sandbox, SANDBOX_NAME);

    const repair = await nemoclaw(
      host,
      ["onboard", "--resume", "--non-interactive"],
      "phase-2-resume-repair",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_POLICY_MODE: "skip",
      }),
    );
    expect(repair.exitCode, resultText(repair)).toBe(0);
    expect(resultText(repair)).toContain("[resume] Skipping preflight (cached)");
    expect(resultText(repair)).toContain("Recorded sandbox state is unavailable; recreating it");
    expect(resultText(repair)).toContain("Creating sandbox");

    const status = await nemoclaw(host, [SANDBOX_NAME, "status"], "phase-2-status-after-repair");
    expect(status.exitCode, resultText(status)).toBe(0);

    const reinject = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-3-reinject-failure",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
    );
    expect(reinject.exitCode, resultText(reinject)).toBe(1);

    const sandboxConflict = await nemoclaw(
      host,
      ["onboard", "--resume", "--non-interactive"],
      "phase-4-conflicting-sandbox",
      onboardEnv(OTHER_SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_POLICY_MODE: "skip",
      }),
    );
    expect(sandboxConflict.exitCode, resultText(sandboxConflict)).toBe(1);
    expect(resultText(sandboxConflict)).toContain(
      `Resumable state belongs to sandbox '${SANDBOX_NAME}', not '${OTHER_SANDBOX_NAME}'`,
    );

    const providerConflict = await nemoclaw(
      host,
      ["onboard", "--resume", "--non-interactive"],
      "phase-5-conflicting-provider-model",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_MODEL: "gpt-5.4",
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_PROVIDER: "openai",
      }),
    );
    expect(providerConflict.exitCode, resultText(providerConflict)).toBe(1);
    expect(resultText(providerConflict)).toMatch(
      /Resumable state recorded provider '.*', not '.*'\./,
    );
    expect(resultText(providerConflict)).toContain("not 'gpt-5.4'");

    await cleanup(host, sandbox);
    expect(fs.existsSync(SESSION_FILE)).toBe(false);
    await artifacts.writeJson("target-result.json", { id: "onboard-repair", status: "passed" });
  },
);
