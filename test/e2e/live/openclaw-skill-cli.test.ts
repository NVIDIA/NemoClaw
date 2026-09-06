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

// Exercise the public stateless lifecycle against the unmodified OpenClaw CLI.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-oc-skill-cli";
const SKILL_ID = "openclaw-skill-cli-fixture";
const SKILL_DESCRIPTION = "E2E fixture proving openclaw skills install + list roundtrip";
const STALE_SKILL_DESCRIPTION = "stale same-name OpenClaw workspace skill";
const EXPECTED_WORKSPACE_SKILL_PATH = `/sandbox/.openclaw/workspace/skills/${SKILL_ID}/SKILL.md`;
const OUTSIDE_WRITABLE_ROOT_SKILL_PATH = `/sandbox/.openclaw/skills/${SKILL_ID}/SKILL.md`;
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

function writeLocalSkillFixture(parent: string): string {
  const directory = path.join(parent, SKILL_ID);
  fs.mkdirSync(directory);
  const skillPayload = [
    "---",
    `name: "${SKILL_ID}"`,
    `description: "${SKILL_DESCRIPTION}"`,
    "---",
    "",
    "# OpenClaw skill CLI roundtrip fixture",
    "",
    "Written by test/e2e/live/openclaw-skill-cli.test.ts.",
  ].join("\n");
  fs.writeFileSync(path.join(directory, "SKILL.md"), skillPayload);
  return directory;
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
  "openclaw-skill-cli: public skill lifecycle delegates to native OpenClaw state",
  {
    timeout: INSTALL_TIMEOUT_MS + 10 * 60_000,
    meta: {
      e2ePhases: [
        "confirm built CLI, selected runtime, and hosted inference",
        "clear the OpenClaw skill CLI sandbox",
        "install and onboard the OpenClaw sandbox",
        "confirm OpenClaw runtime directories",
        "install and list the workspace skill through NemoClaw",
        "remove only the canonical writable-root copy",
        "record the stateless native-agent contract",
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
      boundary: "install-sh-onboard-and-public-stateless-openclaw-skill-lifecycle",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "the selected runtime is available before install/onboard",
        "NVIDIA_INFERENCE_API_KEY is staged as the compatible endpoint credential",
        "install.sh creates/recreates a real OpenClaw sandbox",
        "OPENCLAW_HOME, OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR reach the sandbox runtime shell",
        "nemoclaw skill install invokes the unmodified native OpenClaw add command",
        "native OpenClaw installation replaces a stale same-name workspace skill",
        "the installed SKILL.md lands under ${OPENCLAW_WORKSPACE_DIR}/skills/<id>",
        "nemoclaw skill list streams the native OpenClaw list",
        "nemoclaw skill remove deletes only the canonical writable-root copy",
        "a same-name OpenClaw copy outside that root remains untouched",
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
    const localSkillDirectory = writeLocalSkillFixture(home);
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
      `printf "OPENCLAW_HOME=%s\\nOPENCLAW_STATE_DIR=%s\\nOPENCLAW_WORKSPACE_DIR=%s\\n" "\${OPENCLAW_HOME:-}" "\${OPENCLAW_STATE_DIR:-}" "\${OPENCLAW_WORKSPACE_DIR:-}"; mkdir -p ${shellQuote(path.posix.dirname(EXPECTED_WORKSPACE_SKILL_PATH))}; printf '%s\\n' ${shellQuote(`---\nname: "${SKILL_ID}"\ndescription: "${STALE_SKILL_DESCRIPTION}"\n---\n# Stale same-name fixture`)} > ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)}`,
      "sandbox-openclaw-runtime-env-check",
      env,
    );
    ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_WORKSPACE_DIR"].forEach((requiredVar) => {
      expect(
        resultText(envCheck),
        `${requiredVar} must be exported in sandbox runtime shell`,
      ).toMatch(new RegExp(`^${requiredVar}=.+$`, "m"));
    });

    progress.phase("install and list the workspace skill through NemoClaw");
    const skillInstall = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "skill", "install", localSkillDirectory],
      {
        artifactName: "nemoclaw-openclaw-skill-install",
        cwd: REPO_ROOT,
        env,
        timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
      },
    );
    expect(skillInstall.exitCode, resultText(skillInstall)).toBe(0);
    await artifacts.writeText("openclaw-skills-install-output.txt", resultText(skillInstall));

    const diskCheck = await expectSandboxShellZero(
      sandbox,
      `ls -1 "\${OPENCLAW_WORKSPACE_DIR}/skills/${SKILL_ID}/" 2>&1; test -f ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)} && grep -Fq ${shellQuote(SKILL_DESCRIPTION)} ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)} && ! grep -Fq ${shellQuote(STALE_SKILL_DESCRIPTION)} ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)} && echo SKILL_MD_PRESENT`,
      "sandbox-openclaw-skill-cli-disk-check",
      env,
    );
    expect(resultText(diskCheck)).toContain("SKILL_MD_PRESENT");

    const list = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "skill", "list", "--json"],
      {
        artifactName: "nemoclaw-openclaw-skill-list-json",
        cwd: REPO_ROOT,
        env,
        timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
      },
    );
    expect(list.exitCode, resultText(list)).toBe(0);
    const listText = resultText(list);
    expect(listText).toContain(`"${SKILL_ID}"`);
    expect(listText).toContain("openclaw-workspace");

    progress.phase("remove only the canonical writable-root copy");
    await expectSandboxShellZero(
      sandbox,
      `mkdir -p ${shellQuote(path.posix.dirname(OUTSIDE_WRITABLE_ROOT_SKILL_PATH))} && cp ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)} ${shellQuote(OUTSIDE_WRITABLE_ROOT_SKILL_PATH)}`,
      "sandbox-openclaw-same-name-outside-writable-root",
      env,
    );
    const remove = await host.command(
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "skill", "remove", SKILL_ID],
      {
        artifactName: "nemoclaw-openclaw-skill-remove",
        cwd: REPO_ROOT,
        env,
        timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
      },
    );
    expect(remove.exitCode, resultText(remove)).toBe(0);
    await expectSandboxShellZero(
      sandbox,
      `test ! -e ${shellQuote(EXPECTED_WORKSPACE_SKILL_PATH)} && test -f ${shellQuote(OUTSIDE_WRITABLE_ROOT_SKILL_PATH)}`,
      "sandbox-openclaw-skill-remove-boundary",
      env,
    );

    progress.phase("record the stateless native-agent contract");
    await artifacts.target.complete({
      id: "openclaw-skill-cli",
      status: "passed",
      sandboxName: SANDBOX_NAME,
      installedSkill: SKILL_ID,
      expectedDiskPath: EXPECTED_WORKSPACE_SKILL_PATH,
    });
  },
);
