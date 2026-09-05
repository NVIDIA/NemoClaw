// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { testHomeEnvironment } from "../fixtures/environment-profiles.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// This intentionally keeps the real host-to-sandbox boundary: run install.sh,
// onboard OpenClaw, install through NemoClaw, then verify through the pinned
// native CLI and workspace filesystem.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-skill-cli";
const SKILL_ID = "openclaw-skill-cli-fixture";
const SKILL_DESCRIPTION = "E2E fixture proving openclaw skills install + list roundtrip";
const EXPECTED_WORKSPACE_SKILL_PATH = `/sandbox/.openclaw/workspace/skills/${SKILL_ID}/SKILL.md`;
const INSTALL_TIMEOUT_MS = 45 * 60_000;
const SANDBOX_EXEC_TIMEOUT_MS = 120_000;
validateSandboxName(SANDBOX_NAME);

function isEndpointRateLimited(text: string): boolean {
  return /HTTP 429|rate limit|too many requests/i.test(text);
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return testHomeEnvironment(home, extra);
}

async function bestEffortPreclean(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup can run before install.sh has placed OpenShell on this test
    // HOME's PATH. Keep it best-effort so setup failures stay primary.
  }
}

async function precleanOpenClawSkillCliState(
  host: HostCliClient,
  sandbox: SandboxClient,
  home: string,
): Promise<void> {
  const env = testEnv(home);
  await bestEffortPreclean(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-openclaw-skill-cli",
      env,
      timeoutMs: 120_000,
    }),
  );
  await bestEffortPreclean(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-openclaw-skill-cli",
      env,
      timeoutMs: 60_000,
    }),
  );
  await bestEffortPreclean(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy-openclaw-skill-cli",
      env,
      timeoutMs: 120_000,
    }),
  );
}

function skillPayload(marker: string): string {
  return [
    "---",
    `name: "${SKILL_ID}"`,
    `description: "${SKILL_DESCRIPTION}"`,
    "---",
    "",
    "# OpenClaw skill CLI roundtrip fixture",
    "",
    marker,
    "",
    "Written by test/e2e/live/openclaw-skill-cli.test.ts.",
  ].join("\n");
}

async function expectSandboxShellZero(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
  env: NodeJS.ProcessEnv,
): Promise<ShellProbeResult> {
  const result = await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName,
    env,
    timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

test(
  "openclaw-skill-cli: NemoClaw native install/update roundtrip uses workspace path",
  {
  timeout: INSTALL_TIMEOUT_MS + 10 * 60_000,
  meta: {
    e2ePhases: [
      "confirm built CLI, selected runtime, and hosted inference",
      "clear the OpenClaw skill CLI sandbox",
      "install and onboard the OpenClaw sandbox",
      "confirm OpenClaw runtime directories",
      "install and update the workspace skill fixture through NemoClaw",
      "inspect the installed skill through every CLI view",
      "record the workspace skill contract",
    ],
  },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
  expect(
    fs.existsSync(CLI_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  await artifacts.target.declare({
    id: "openclaw-skill-cli",
    boundary: "install-sh-onboard-and-nemoclaw-native-skill-install",
    sandboxName: SANDBOX_NAME,
    contracts: [
      "the selected runtime is available before install/onboard",
      "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
      "install.sh creates/recreates a real OpenClaw sandbox",
      "OPENCLAW_HOME, OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR reach the sandbox runtime shell",
      "nemoclaw skill install securely hands host content to the native OpenClaw installer",
      "a second install updates only the receipt-owned unchanged workspace skill",
      "the installed SKILL.md lands under ${OPENCLAW_WORKSPACE_DIR}/skills/<id>",
      "openclaw skills list --agent main --json enumerates the installed workspace skill",
      "openclaw skills info <id> --agent main --json reports the workspace install path",
      "openclaw skills check --agent main --json includes the installed skill",
    ],
  });

  const hosted = requireHostedInferenceConfig(secrets);
  const apiKey = hosted.apiKey;

    await runtimeProvider.requireAvailable({
    artifactName: "prereq-runtime-info-openclaw-skill-cli",
      scenarioLabel: "OpenClaw skill CLI",
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-skill-cli-home-"));
  const env = testEnv(home);
  const localSkillDir = path.join(home, "fixtures", SKILL_ID);
  cleanup.trackDisposable(`remove openclaw-skill-cli test home for ${SANDBOX_NAME}`, () => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway-destroy-openclaw-skill-cli",
    env,
    timeoutMs: 120_000,
  });
  cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-sandbox-delete-openclaw-skill-cli",
      env,
      timeoutMs: 60_000,
    }),
  );
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy-openclaw-skill-cli",
    env,
    timeoutMs: 120_000,
  });
  progress.phase("clear the OpenClaw skill CLI sandbox");
  await precleanOpenClawSkillCliState(host, sandbox, home);

  progress.phase("install and onboard the OpenClaw sandbox");
  const install = await host.command(
    "bash",
    ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
    {
      artifactName: "install-and-onboard-openclaw-skill-cli",
      cwd: REPO_ROOT,
      env: testEnv(home, {
        ...hosted.env,
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
      redactionValues: [apiKey],
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  const installText = resultText(install);
  if (install.exitCode !== 0 && isEndpointRateLimited(installText)) {
    await artifacts.writeText("endpoint-rate-limit-skip.txt", installText);
    skip(
      "NVIDIA endpoint validation was rate-limited before the OpenClaw skill CLI contract could run",
    );
  }
  expect(install.exitCode, installText).toBe(0);

  progress.phase("confirm OpenClaw runtime directories");
  const envCheck = await expectSandboxShellZero(
    sandbox,
    'printf "OPENCLAW_HOME=%s\\nOPENCLAW_STATE_DIR=%s\\nOPENCLAW_WORKSPACE_DIR=%s\\n" "${OPENCLAW_HOME:-}" "${OPENCLAW_STATE_DIR:-}" "${OPENCLAW_WORKSPACE_DIR:-}"',
    "sandbox-openclaw-runtime-env-check",
    env,
  );
  ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_WORKSPACE_DIR"].forEach((requiredVar) => {
    expect(
      resultText(envCheck),
      `${requiredVar} must be exported in sandbox runtime shell`,
    ).toMatch(new RegExp(`^${requiredVar}=.+$`, "m"));
  });

  progress.phase("install and update the workspace skill fixture through NemoClaw");
  fs.mkdirSync(localSkillDir, { recursive: true });
  fs.writeFileSync(path.join(localSkillDir, "SKILL.md"), skillPayload("HOST_FIXTURE_VERSION=1"));
  const skillInstall = await host.command(
    "node",
    [CLI_ENTRYPOINT, SANDBOX_NAME, "skill", "install", localSkillDir],
    {
      artifactName: "nemoclaw-openclaw-skill-install-fixture",
      env,
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  expect(skillInstall.exitCode, resultText(skillInstall)).toBe(0);
  await artifacts.writeText("openclaw-skills-install-output.txt", resultText(skillInstall));

  fs.writeFileSync(path.join(localSkillDir, "SKILL.md"), skillPayload("HOST_FIXTURE_VERSION=2"));
  const skillUpdate = await host.command(
    "node",
    [CLI_ENTRYPOINT, SANDBOX_NAME, "skill", "install", localSkillDir],
    {
      artifactName: "nemoclaw-openclaw-skill-update-fixture",
      env,
      timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
    },
  );
  expect(skillUpdate.exitCode, resultText(skillUpdate)).toBe(0);
  await artifacts.writeText("openclaw-skills-update-output.txt", resultText(skillUpdate));

  progress.phase("inspect the installed skill through every CLI view");
  const diskCheck = await expectSandboxShellZero(
    sandbox,
    `ls -1 "\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/" 2>&1 && grep -Fq HOST_FIXTURE_VERSION=2 "\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/SKILL.md" && test -z "$(find /sandbox/.openclaw -maxdepth 1 -name '.nemoclaw-skill-stage.*' -print -quit)"`,
    "sandbox-openclaw-skill-cli-disk-check",
    env,
  );
  await artifacts.writeText("openclaw-skill-disk-check.txt", resultText(diskCheck));

  const list = await expectSandboxShellZero(
    sandbox,
    "openclaw skills list --agent main --json",
    "sandbox-openclaw-skills-list-json",
    env,
  );
  const listText = resultText(list);
  expect(listText).toContain(`"${SKILL_ID}"`);
  expect(listText).toContain("openclaw-workspace");

  const info = await expectSandboxShellZero(
    sandbox,
    `openclaw skills info ${shellQuote(SKILL_ID)} --agent main --json`,
    "sandbox-openclaw-skills-info-json",
    env,
  );
  const infoText = resultText(info);
  expect(infoText).toContain(`/.openclaw/workspace/skills/${SKILL_ID}`);

  const check = await expectSandboxShellZero(
    sandbox,
    "openclaw skills check --agent main --json",
    "sandbox-openclaw-skills-check-json",
    env,
  );
  expect(resultText(check)).toContain(`"${SKILL_ID}"`);

  progress.phase("record the workspace skill contract");
  await artifacts.target.complete({
    id: "openclaw-skill-cli",
    status: "passed",
    sandboxName: SANDBOX_NAME,
    installedSkill: SKILL_ID,
    expectedDiskPath: EXPECTED_WORKSPACE_SKILL_PATH,
  });
  },
);
